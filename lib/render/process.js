/**
 * Small child-process helper shared by the browser and Pillow engines.
 *
 * stdio is backed by files (not pipes): a DOM dump can be several hundred KB,
 * and file descriptors keep working even where anonymous pipes are restricted.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const DEFAULT_PROCESS_TIMEOUT_MS = 20000;

/**
 * @typedef {Object} ProcessResult
 * @property {boolean} ok exit code 0
 * @property {number|null} [code]
 * @property {string|null} [signal]
 * @property {boolean} [timedOut]
 * @property {Error} [error] spawn failure
 */

/**
 * Run a process to completion.
 *
 * @param {Object} options
 * @param {string} options.command
 * @param {string[]} [options.args]
 * @param {string} [options.stdoutPath] file that receives stdout
 * @param {string} [options.stderrPath] file that receives stderr
 * @param {number} [options.timeoutMs]
 * @returns {Promise<ProcessResult>}
 */
export function runProcess({
  command,
  args = [],
  stdoutPath,
  stderrPath,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let outFd = null;
    let errFd = null;
    let child = null;
    let timer = null;
    let settled = false;

    const closeFds = () => {
      if (outFd !== null) {
        try { fs.closeSync(outFd); } catch { /* ignore */ }
        outFd = null;
      }
      if (errFd !== null) {
        try { fs.closeSync(errFd); } catch { /* ignore */ }
        errFd = null;
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeFds();
      resolve(result);
    };

    try {
      if (stdoutPath) outFd = fs.openSync(stdoutPath, 'w');
      if (stderrPath) errFd = fs.openSync(stderrPath, 'w');
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', outFd === null ? 'ignore' : outFd, errFd === null ? 'ignore' : errFd],
      });
    } catch (error) {
      finish({ ok: false, error });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Chromium spawns a process tree; killing the launcher alone can leave
      // renderer children behind and poison the next launch in this process.
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', () => {});
        }
      } catch { /* ignore */ }
      finish({ ok: false, timedOut: true });
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_PROCESS_TIMEOUT_MS));

    child.once('error', (error) => finish({ ok: false, error }));
    child.once('close', (code, signal) => finish({ ok: code === 0, code, signal }));
  });
}
