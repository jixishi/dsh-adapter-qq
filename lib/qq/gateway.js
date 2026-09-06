import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * QQ Open Platform WebSocket Gateway Protocol OpCodes
 */
export const OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/**
 * Intents for C2C messages and interaction callbacks
 * (1 << 25): GROUP_AND_C2C_EVENT (Includes C2C_MESSAGE_CREATE)
 * (1 << 26): INTERACTION (Includes INTERACTION_CREATE for button callbacks)
 */
export const DEFAULT_INTENTS = (1 << 25) | (1 << 26);

export class QQGatewayClient extends EventEmitter {
  /**
   * @param {Object} options
   * @param {import('./client.js').QQApiClient} options.apiClient
   * @param {number} [options.intents]
   * @param {Object} [options.logger]
   */
  constructor({ apiClient, intents = DEFAULT_INTENTS, logger = console }) {
    super();
    this.apiClient = apiClient;
    this.intents = intents;
    this.logger = logger;

    this.ws = null;
    this.connected = false;
    this.closedExplicitly = false;

    this.sessionId = null;
    this.lastSeq = null;
    this.heartbeatTimer = null;
    this.heartbeatInterval = 45000;
    this.lastHeartbeatAck = true;

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.botUser = null;
  }

  /**
   * Connect to the WebSocket Gateway
   */
  async connect() {
    this.closedExplicitly = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();

    try {
      this.logger.info?.('[QQGateway] Fetching gateway URL...');
      const gatewayUrl = await this.apiClient.getGatewayUrl();
      this.logger.info?.(`[QQGateway] Connecting to ${gatewayUrl}...`);

      this.ws = new WebSocket(gatewayUrl);
      this.setupSocketHandlers();
    } catch (err) {
      this.logger.error?.(`[QQGateway] Failed to initialize connection: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Bind WebSocket event listeners
   */
  setupSocketHandlers() {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.info?.('[QQGateway] WebSocket socket opened, awaiting Hello...');
    });

    this.ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const payload = JSON.parse(text);
        this.handlePayload(payload);
      } catch (err) {
        this.logger.error?.(`[QQGateway] Error parsing inbound message: ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString('utf8') : '';
      this.logger.warn?.(`[QQGateway] WebSocket closed: code=${code}, reason=${reasonStr}`);
      this.cleanupSocket();
      this.emit('disconnect', { code, reason: reasonStr });

      if (!this.closedExplicitly) {
        // Code 4009 is QQ server's routine timeout (~30min); can RESUME seamlessly
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error?.(`[QQGateway] WebSocket error: ${err.message}`);
      this.emit('error', err);
    });
  }

  /**
   * Handle incoming Gateway OpCodes
   * @param {Object} payload
   */
  handlePayload(payload) {
    const { op, s, t, d } = payload;

    if (s !== undefined && s !== null) {
      this.lastSeq = s;
    }

    switch (op) {
      case OpCode.HELLO:
        this.handleHello(d);
        break;

      case OpCode.HEARTBEAT_ACK:
        this.lastHeartbeatAck = true;
        break;

      case OpCode.DISPATCH:
        this.handleDispatch(t, d);
        break;

      case OpCode.RECONNECT:
        this.logger.info?.('[QQGateway] Received OpCode 7 (Reconnect requested by server)');
        this.reconnect();
        break;

      case OpCode.INVALID_SESSION:
        this.logger.warn?.('[QQGateway] Received OpCode 9 (Invalid Session). Resetting session and re-identifying...');
        this.sessionId = null;
        this.lastSeq = null;
        this.reconnect();
        break;

      case OpCode.HEARTBEAT:
        // Server asks for immediate heartbeat
        this.sendHeartbeat();
        break;

      default:
        this.logger.debug?.(`[QQGateway] Received unknown OpCode: ${op}`);
        break;
    }
  }

  /**
   * Handle OpCode 10 Hello
   * @param {Object} d
   */
  handleHello(d) {
    this.heartbeatInterval = d.heartbeat_interval || 45000;
    this.logger.info?.(`[QQGateway] Handshake Hello received. Heartbeat interval: ${this.heartbeatInterval}ms`);
    this.startHeartbeat();

    if (this.sessionId && this.lastSeq !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  /**
   * Send OpCode 2 Identify
   */
  async sendIdentify() {
    try {
      const token = await this.apiClient.getAccessToken();
      const payload = {
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: 'dsh-qq-bot',
            $device: 'dsh-qq-bot',
          },
        },
      };

      this.logger.info?.(`[QQGateway] Sending Identify (intents=${this.intents})...`);
      this.sendJson(payload);
    } catch (err) {
      this.logger.error?.(`[QQGateway] Failed to send Identify: ${err.message}`);
      this.reconnect();
    }
  }

  /**
   * Send OpCode 6 Resume
   */
  async sendResume() {
    try {
      const token = await this.apiClient.getAccessToken();
      const payload = {
        op: OpCode.RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSeq,
        },
      };

      this.logger.info?.(`[QQGateway] Sending Resume (session_id=${this.sessionId}, seq=${this.lastSeq})...`);
      this.sendJson(payload);
    } catch (err) {
      this.logger.error?.(`[QQGateway] Failed to send Resume: ${err.message}`);
      this.sessionId = null;
      this.lastSeq = null;
      this.sendIdentify();
    }
  }

  /**
   * Send OpCode 1 Heartbeat
   */
  sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (!this.lastHeartbeatAck) {
      this.logger.warn?.('[QQGateway] Heartbeat ACK missing from previous cycle. Stale connection detected, reconnecting...');
      this.reconnect();
      return;
    }

    this.lastHeartbeatAck = false;
    this.sendJson({
      op: OpCode.HEARTBEAT,
      d: this.lastSeq,
    });
  }

  /**
   * Start heartbeat periodic interval
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeatAck = true;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, Math.max(10000, this.heartbeatInterval * 0.9));
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle OpCode 0 Dispatch events
   * @param {string} type - Event type
   * @param {Object} data - Event data
   */
  handleDispatch(type, data) {
    switch (type) {
      case 'READY':
        this.connected = true;
        this.reconnectAttempts = 0;
        this.sessionId = data.session_id;
        this.botUser = data.user;
        this.logger.info?.(`[QQGateway] Gateway READY! Logged in as: ${data.user?.username} (${data.user?.id}), session: ${this.sessionId}`);
        this.emit('ready', { botUser: this.botUser, sessionId: this.sessionId });
        break;

      case 'RESUMED':
        this.connected = true;
        this.reconnectAttempts = 0;
        this.logger.info?.('[QQGateway] Gateway RESUMED successfully!');
        this.emit('resumed');
        break;

      case 'C2C_MESSAGE_CREATE':
        this.logger.info?.(`[QQGateway] Received C2C_MESSAGE_CREATE from user: ${data.author?.user_openid || data.author?.id}`);
        this.emit('c2c_message', data);
        break;

      case 'INTERACTION_CREATE':
        this.logger.info?.(`[QQGateway] Received INTERACTION_CREATE: id=${data.id}`);
        this.emit('interaction', data);
        break;

      default:
        this.logger.debug?.(`[QQGateway] Received event: ${type}`);
        this.emit(type, data);
        break;
    }
  }

  /**
   * Send JSON payload through WebSocket
   * @param {Object} obj
   */
  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Schedule automatic reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.closedExplicitly) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    // Backoff: 1s, 2s, 4s, 8s, up to 30s
    const delay = Math.min(30000, Math.pow(2, Math.min(5, this.reconnectAttempts)) * 1000);
    this.logger.info?.(`[QQGateway] Scheduling reconnection in ${delay}ms (attempt #${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Force disconnect and trigger immediate reconnect
   */
  reconnect() {
    this.closedExplicitly = false;
    this.cleanupSocket();
    this.connect();
  }

  /**
   * Clean up socket and timers
   */
  cleanupSocket() {
    this.connected = false;
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Explicitly disconnect and terminate gateway
   */
  disconnect() {
    this.closedExplicitly = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
    this.logger.info?.('[QQGateway] Disconnected explicitly.');
  }
}
