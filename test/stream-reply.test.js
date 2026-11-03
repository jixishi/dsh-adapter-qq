import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MessageBridge } from '../lib/sync/message-bridge.js';

function createBridge({ config = {}, sent = [] } = {}) {
  const apiClient = {
    async sendC2CMessage(openid, msg) {
      sent.push(msg);
      return { id: `m${sent.length}` };
    },
    async sendTyping() {},
    async sendImage() {
      return { fileInfo: 'x', messageId: 'i1' };
    },
    async sendFile() {
      return { fileInfo: 'y', messageId: 'f1' };
    },
  };
  const bridge = new MessageBridge({
    ctx: {
      on: () => () => {},
      get: (name) => (name === 'attachments' ? null : undefined),
      logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    },
    apiClient,
    gateway: new EventEmitter(),
    sessionManager: {
      getSessionStats: async () => null,
      getActiveSessionId: async () => 's1',
    },
    approvalHandler: { start() {}, stop() {} },
    getConfig: () => ({
      autoSendAttachments: false,
      sendOverviewCaption: false,
      streamReply: false,
      streamIntervalMs: 500,
      ...config,
    }),
    updateConfig: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return bridge;
}

const assistantMessage = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
});

const chunk = (text) => ({ type: 'assistant/chunk', data: { text } });

describe('streaming reply option', () => {
  it('sends the whole reply once when streamReply is disabled', async () => {
    const sent = [];
    const bridge = createBridge({ sent });
    bridge.lastMsgId = 'msg1';
    bridge.lastMsgTime = Date.now();

    bridge.onDshAssistantChunk('user', 's1', chunk('你好'));
    bridge.onDshAssistantChunk('user', 's1', chunk('，世界'));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(sent.length, 0, 'no incremental messages when the option is off');

    await bridge.onDshAssistantMessage('user', 's1', assistantMessage('你好，世界'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].markdown, '你好，世界');
  });

  it('pushes only the unsent remainder when streamReply is enabled', async () => {
    const sent = [];
    const bridge = createBridge({ config: { streamReply: true, streamIntervalMs: 500 }, sent });
    bridge.lastMsgId = 'msg1';
    bridge.lastMsgTime = Date.now();

    bridge.onDshAssistantChunk('user', 's1', chunk('第一段内容。'));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(sent.length, 1, 'the first chunk is streamed');
    assert.equal(sent[0].markdown, '第一段内容。');

    bridge.onDshAssistantChunk('user', 's1', chunk('第二段内容。'));
    await bridge.onDshAssistantMessage('user', 's1', assistantMessage('第一段内容。第二段内容。'));

    const combined = sent.map((msg) => msg.markdown).join('');
    assert.equal(combined, '第一段内容。第二段内容。', 'streamed prefix must not be duplicated');
  });

  it('sends nothing extra when streaming already delivered the full text', async () => {
    const sent = [];
    const bridge = createBridge({ config: { streamReply: true, streamIntervalMs: 500 }, sent });
    bridge.lastMsgId = 'msg1';
    bridge.lastMsgTime = Date.now();

    bridge.onDshAssistantChunk('user', 's1', chunk('完整回复'));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(sent.length, 1);

    await bridge.onDshAssistantMessage('user', 's1', assistantMessage('完整回复'));
    assert.equal(sent.length, 1, 'no duplicate final message');
  });

  it('strips internal tags from streamed fragments', () => {
    const bridge = createBridge();
    assert.equal(bridge.stripStreamNoise('<think>hidden</think>可见内容'), '可见内容');
    assert.equal(bridge.stripStreamNoise('<system-reminder>x</system-reminder>正文'), '正文');
    assert.equal(bridge.stripStreamNoise('  正常文本  '), '正常文本');
  });
});
