import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
