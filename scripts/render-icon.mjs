/**
 * 把 icon.svg 渲染成多尺寸预览图，用于人工确认图标在小尺寸下是否还可辨认。
 *
 * 只做渲染，不删除任何东西 —— 覆盖预览文件用写入方式完成。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 以脚本自身位置定位仓库根，这样在任何人机器上都能跑（不写死绝对路径）。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const svg = readFileSync(join(root, 'icon.svg'), 'utf8')

const html = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#1a1f2b;display:flex;gap:28px;align-items:center;justify-content:center;height:520px;font-family:sans-serif}
.cap{color:#8ba0bb;font-size:13px;text-align:center;margin-top:8px}
figure{margin:0;display:flex;flex-direction:column;align-items:center}</style>
<figure><div style="width:400px;height:400px">${svg}</div><div class="cap">400px</div></figure>
<figure><div style="width:120px;height:120px">${svg}</div><div class="cap">120px</div></figure>
<figure><div style="width:64px;height:64px">${svg}</div><div class="cap">64px</div></figure>
<figure><div style="width:40px;height:40px">${svg}</div><div class="cap">40px</div></figure>`

const previewHtml = join(root, 'icon-preview.html')
writeFileSync(previewHtml, html, 'utf8')

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const shot = join(root, 'icon-preview.png')
const stamp = Date.now()

try {
  execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--user-data-dir=${join(tmpdir(), `edge-shot-${stamp}`)}`,
      `--screenshot=${shot}`,
      '--window-size=760,520',
      `file:///${previewHtml.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  )
  console.log(`rendered ${shot}`)
} catch (error) {
  console.log(`render failed: ${error instanceof Error ? error.message : String(error)}`)
}
