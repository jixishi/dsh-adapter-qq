/**
 * Pillow fallback engine.
 *
 * When no headless browser is usable we can still produce a PNG with
 * Python + Pillow: probe `python` / `py -3` (and `QQ_ADAPTER_PYTHON`), then
 * hand a JSON job file to a small inline script. Any problem resolves to
 * `null` so the caller can fall through to the SVG engine.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.js';
import { parsePngSize } from './browser.js';

const PROBE_TIMEOUT_MS = 15000;
const RENDER_TIMEOUT_MS = 30000;

const PY_SCRIPT = String.raw`import json, sys
from PIL import Image, ImageDraw, ImageFont

def load_job(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return json.load(fh)

def load_font(paths, size):
    for candidate in paths:
        try:
            return ImageFont.truetype(candidate, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None

def main():
    job = load_job(sys.argv[1])
    text = job.get('text') or ''
    title = job.get('title') or ''
    truncated = job.get('truncatedLabel') or '... [truncated]'
    width = int(job.get('width') or 900)
    theme = job.get('theme') or 'light'
    out = job.get('out')
    width = max(320, min(2400, width))
    dark = (theme == 'dark')
    if dark:
        bg, fg, muted, accent = (27, 30, 36), (232, 234, 237), (150, 156, 166), (121, 166, 255)
    else:
        bg, fg, muted, accent = (255, 255, 255), (28, 29, 33), (102, 108, 120), (47, 111, 235)

    body_size = 20
    title_size = 30
    line_gap = 12
    title_gap = 14
    pad = 36
    inner_w = width - pad * 2
    line_h = body_size + line_gap

    font_paths = [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyh.ttf',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        'C:/Windows/Fonts/Deng.ttf',
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    title_paths = [
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/msyhbd.ttf',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/msyh.ttc',
        '/System/Library/Fonts/PingFang.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]

    body_font = load_font(font_paths, body_size)
    title_font = load_font(title_paths, title_size)
    probe = Image.new('RGB', (8, 8), bg)
    probe_draw = ImageDraw.Draw(probe)

    def measure(value, font):
        if not value:
            return 0
        try:
            return float(probe_draw.textlength(value, font=font))
        except Exception:
            return len(value) * body_size * 0.62

    def wrap(value, font, max_width):
        lines = []
        normalized = str(value).replace('\r\n', '\n').replace('\r', '\n')
        for raw in normalized.split('\n'):
            if raw.strip() == '':
                lines.append('')
                continue
            current = ''
            for ch in raw:
                trial = current + ch
                if current and measure(trial, font) > max_width:
                    lines.append(current)
                    current = ch
                else:
                    current = trial
            lines.append(current)
        return lines

    title_lines = wrap(title, title_font, inner_w) if title else []
    body_lines = wrap(text, body_font, inner_w)
    header_h = (len(title_lines) * (title_size + title_gap) + 22) if title_lines else 0
    max_lines = max(1, (15000 - pad * 2 - header_h) // line_h)
    if len(body_lines) > max_lines:
        body_lines = body_lines[:max(0, max_lines - 1)] + [truncated]
    if not body_lines:
        body_lines = ['']
    height = pad * 2 + header_h + len(body_lines) * line_h
    height = max(200, min(16000, height))

    image = Image.new('RGB', (width, height), bg)
    draw = ImageDraw.Draw(image)
    y = pad
    if title_lines:
        for line in title_lines:
            if line:
                draw.text((pad, y), line, font=title_font, fill=accent)
            y += title_size + title_gap
        y += 6
        draw.line([(pad, y), (width - pad, y)], fill=muted, width=1)
        y += 16
    for line in body_lines:
        if line:
            draw.text((pad, y), line, font=body_font, fill=fg)
        y += line_h
    image.save(out, 'PNG')
    sys.stdout.write(json.dumps({'ok': True, 'width': image.width, 'height': image.height}))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        sys.stderr.write('pillow-render-failed: %s\n' % (exc,))
        sys.exit(1)
`;

const PY_PROBE = 'import PIL,sys; sys.stdout.write(PIL.__version__)';

/** @type {Promise<{command:string,args:string[]}|null>|null} */
let pythonProbe = null;

async function probePython() {
  if (pythonProbe) return pythonProbe;
  pythonProbe = (async () => {
    /** @type {Array<{command:string,args:string[]}>} */
    const candidates = [];
    const fromEnv = String(process.env.QQ_ADAPTER_PYTHON || '').trim().replace(/^"|"$/g, '');
    if (fromEnv) candidates.push({ command: fromEnv, args: [] });
    candidates.push({ command: 'python', args: [] });
    candidates.push({ command: 'python3', args: [] });
    candidates.push({ command: 'py', args: ['-3'] });

    for (const candidate of candidates) {
      let tmpDir = null;
      try {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-py-probe-'));
        const stdoutPath = path.join(tmpDir, 'out.txt');
        const result = await runProcess({
          command: candidate.command,
          args: [...candidate.args, '-c', PY_PROBE],
          stdoutPath,
          stderrPath: path.join(tmpDir, 'err.txt'),
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (!result.ok) continue;
        const version = (await fsp.readFile(stdoutPath, 'utf8')).trim();
        if (/^\d+\.\d+/.test(version)) return candidate;
      } catch {
        // try the next interpreter
      } finally {
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    return null;
  })();
  return pythonProbe;
}

/**
 * Pillow's fallback CJK fonts carry no emoji/dingbat glyphs, which renders as
 * tofu boxes (□). Keep the few meaningful markers as text and drop the rest.
 * @param {string} value
 * @returns {string}
 */
export function sanitizePillowText(value) {
  return String(value ?? '')
    .replace(/✅/g, '[OK]')
    .replace(/❌/g, '[X]')
    .replace(/⚠️?/g, '[!]')
    .replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Render plain text into a PNG with Pillow (Chinese-friendly font, wrapping).
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {string} [options.title]
 * @param {number} [options.width]
 * @param {string} options.outPath
 * @param {'light'|'dark'} [options.theme]
 * @param {Console|Object} [options.logger]
 * @returns {Promise<{path:string,width:number,height:number,bytes:number}|null>}
 */
export async function renderTextWithPillow({
  text = '',
  title = '',
  width = 900,
  outPath,
  theme = 'light',
  logger = console,
} = {}) {
  if (!outPath || typeof outPath !== 'string') return null;

  let python = null;
  try {
    python = await probePython();
  } catch {
    python = null;
  }
  if (!python) return null;

  let tmpDir = null;
  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pillow-'));
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    const jobPath = path.join(tmpDir, 'job.json');
    const job = {
      text: sanitizePillowText(text),
      title: sanitizePillowText(title),
      width: Math.max(320, Math.min(2400, Math.round(Number(width) || 900))),
      theme: theme === 'dark' ? 'dark' : 'light',
      out: path.resolve(outPath),
      truncatedLabel: '…（内容过长，已截断）',
    };
    await fsp.writeFile(jobPath, JSON.stringify(job), 'utf8');

    const result = await runProcess({
      command: python.command,
      args: [...python.args, '-c', PY_SCRIPT, jobPath],
      stdoutPath: path.join(tmpDir, 'out.txt'),
      stderrPath: path.join(tmpDir, 'err.txt'),
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (!result.ok) {
      try {
        const stderr = await fsp.readFile(path.join(tmpDir, 'err.txt'), 'utf8');
        logger?.warn?.(`[adapter-qq] Pillow 渲染失败：${stderr.trim().split('\n').slice(-1)[0] || result.code}`);
      } catch {
        logger?.warn?.('[adapter-qq] Pillow 渲染失败');
      }
      return null;
    }

    const png = await fsp.readFile(outPath).catch(() => null);
    const size = png ? parsePngSize(png) : null;
    if (!size) return null;
    return { path: outPath, width: size.width, height: size.height, bytes: png.length };
  } catch (error) {
    logger?.warn?.(`[adapter-qq] Pillow 渲染异常：${error?.message ?? error}`);
    return null;
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
