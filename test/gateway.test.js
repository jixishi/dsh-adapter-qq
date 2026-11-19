import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { QQGatewayClient, OpCode, DEFAULT_INTENTS } from '../lib/qq/gateway.js';

describe('QQGatewayClient', () => {
  it('should initialize with default intents and apiClient', () => {
    const mockApiClient = {
      getGatewayUrl: async () => 'wss://mock.api/websocket',
      getAccessToken: async () => 'mock_token',
    };

    const gw = new QQGatewayClient({
      apiClient: mockApiClient,
    });

    assert.equal(gw.intents, DEFAULT_INTENTS);
    assert.equal(gw.connected, false);
    assert.equal(gw.sessionId, null);
    assert.equal(gw.lastSeq, null);
  });

  it('should handle OpCode 10 Hello and start heartbeat', (t, done) => {
    const mockApiClient = {
      getAccessToken: async () => 'mock_token',
    };
    const gw = new QQGatewayClient({ apiClient: mockApiClient });

    let sentPayload = null;
    gw.sendJson = (payload) => {
      sentPayload = payload;
    };

    gw.handlePayload({
      op: OpCode.HELLO,
      d: { heartbeat_interval: 1000 },
    });

    assert.equal(gw.heartbeatInterval, 1000);
    assert.ok(gw.heartbeatTimer !== null);

    // Should have sent OpCode 2 Identify since no prior session
    setTimeout(() => {
      assert.ok(sentPayload);
      assert.equal(sentPayload.op, OpCode.IDENTIFY);
      assert.equal(sentPayload.d.token, 'QQBot mock_token');
      assert.equal(sentPayload.d.intents, DEFAULT_INTENTS);
      gw.disconnect();
      done();
    }, 10);
  });

  it('should handle OpCode 0 READY event', (t, done) => {
    const mockApiClient = {};
    const gw = new QQGatewayClient({ apiClient: mockApiClient });

    gw.on('ready', ({ botUser, sessionId }) => {
      assert.equal(botUser.username, 'MyBot');
      assert.equal(sessionId, 'sess_xyz');
      assert.equal(gw.connected, true);
      assert.equal(gw.sessionId, 'sess_xyz');
      done();
    });

    gw.handlePayload({
      op: OpCode.DISPATCH,
      s: 1,
      t: 'READY',
      d: {
        version: 1,
        session_id: 'sess_xyz',
        user: { id: 'bot_1', username: 'MyBot', bot: true },
      },
    });
  });

  it('should handle OpCode 0 C2C_MESSAGE_CREATE event', (t, done) => {
    const mockApiClient = {};
    const gw = new QQGatewayClient({ apiClient: mockApiClient });

    gw.on('c2c_message', (data) => {
      assert.equal(data.id, 'msg_001');
      assert.equal(data.content, 'Hello Bot');
      assert.equal(gw.lastSeq, 42);
      done();
    });

    gw.handlePayload({
      op: OpCode.DISPATCH,
      s: 42,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg_001',
        content: 'Hello Bot',
        author: { user_openid: 'user_999' },
      },
    });
  });

  it('should handle OpCode 0 INTERACTION_CREATE event', (t, done) => {
    const mockApiClient = {};
    const gw = new QQGatewayClient({ apiClient: mockApiClient });

    gw.on('interaction', (data) => {
      assert.equal(data.id, 'interact_123');
      assert.equal(data.data.resolved.button_data, '/sessions');
      done();
    });

    gw.handlePayload({
      op: OpCode.DISPATCH,
      s: 43,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interact_123',
        data: {
          resolved: { button_data: '/sessions' },
        },
      },
    });
  });

  it('should handle OpCode 9 Invalid Session and clear session state', () => {
    const mockApiClient = {};
    const gw = new QQGatewayClient({ apiClient: mockApiClient });
    gw.sessionId = 'old_sess';
    gw.lastSeq = 10;

    let reconnected = false;
    gw.reconnect = () => {
      reconnected = true;
    };

    gw.handlePayload({
      op: OpCode.INVALID_SESSION,
    });

    assert.equal(gw.sessionId, null);
    assert.equal(gw.lastSeq, null);
    assert.equal(reconnected, true);
  });

  it('keeps an error listener on CONNECTING sockets closed during cleanupSocket()', async () => {
    const gw = new QQGatewayClient({ apiClient: {}, logger: { info() {}, warn() {}, error() {} } });
    const fakeWs = new EventEmitter();
    let terminated = false;
    let closed = false;
    fakeWs.readyState = WebSocket.CONNECTING;
    fakeWs.terminate = () => {
      terminated = true;
      process.nextTick(() => {
        fakeWs.emit('error', new Error('WebSocket was closed before the connection was established'));
      });
    };
    fakeWs.close = () => {
      closed = true;
    };

    gw.ws = fakeWs;
    gw.setupSocketHandlers(fakeWs);
    gw.cleanupSocket();

    assert.equal(terminated, true);
    assert.equal(closed, false);
    assert.equal(gw.ws, null);
    assert.ok(fakeWs.listenerCount('error') >= 1);

    // Wait past nextTick so deferred emit('error') fires cleanly without uncaught exception
    await new Promise((r) => setTimeout(r, 10));
  });

  it('tracks isActiveOrConnecting() across handshake, open, and cleanup states', () => {
    const gw = new QQGatewayClient({ apiClient: {} });
    assert.equal(gw.isActiveOrConnecting(), false);

    gw.connecting = true;
    assert.equal(gw.isActiveOrConnecting(), true);

    gw.connecting = false;
    gw.ws = { readyState: WebSocket.CONNECTING };
    assert.equal(gw.isActiveOrConnecting(), true);

    gw.ws = { readyState: WebSocket.OPEN };
    assert.equal(gw.isActiveOrConnecting(), true);

    gw.ws = { readyState: WebSocket.CLOSED };
    assert.equal(gw.isActiveOrConnecting(), false);

    gw.connected = true;
    assert.equal(gw.isActiveOrConnecting(), true);
  });

  it('ignores stale getGatewayUrl() completions after disconnect() or newer connect()', async () => {
    let resolveFirst;
    let rejectFirst;
    let calls = 0;
    const apiClient = {
      getGatewayUrl: () => {
        calls += 1;
        return new Promise((resolve, reject) => {
          resolveFirst = resolve;
          rejectFirst = reject;
        });
      },
    };
    const gw = new QQGatewayClient({ apiClient, logger: { info() {}, warn() {}, error() {} } });

    const p1 = gw.connect();
    assert.equal(gw.connecting, true);
    assert.equal(calls, 1);

    // Disconnect supersedes the in-flight getGatewayUrl fetch
    gw.disconnect();
    assert.equal(gw.connecting, false);
    resolveFirst('wss://127.0.0.1:1/stale');
    await p1;
    assert.equal(gw.ws, null);
    assert.equal(gw.isActiveOrConnecting(), false);

    // Rejected stale fetch after disconnect must not reset state or schedule reconnect
    const p2 = gw.connect();
    gw.disconnect();
    rejectFirst(new Error('network abort'));
    await p2;
    assert.equal(gw.reconnectTimer, null);
  });

  it('does not throw when socket errors fire without external gateway error listeners', () => {
    const gw = new QQGatewayClient({ apiClient: {}, logger: { info() {}, warn() {}, error() {} } });
    const fakeWs = new EventEmitter();
    fakeWs.readyState = WebSocket.OPEN;
    gw.ws = fakeWs;
    gw.setupSocketHandlers(fakeWs);

    assert.equal(gw.listenerCount('error'), 0);
    assert.doesNotThrow(() => {
      fakeWs.emit('error', new Error('transient socket error'));
    });
  });
});
