import { basename } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { validWorkOutput, type WorkMediaReference } from './work-output.js';

function imageType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  const bytes = Buffer.from(data);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Installed only on a child reserved by the authenticated work channel. No protocol send capability. */
export function installWorkAttachmentTool(agent: Agent, options: {
  readonly assertLease: () => void;
  readonly commit: (asset: WorkMediaReference) => void;
}): () => void {
  return agent.ctx.tools.register(defineTool({
    name: 'qbf_work_attach',
    description: '将本次工作的现有图片或文件登记为结果附件，工作完成后由宿主回传原QQ会话。path按当前工作目录解析；kind=image发送图片，kind=file发送文件，省略时根据真实文件字节识别图片。每项最多8MiB，本次工作最多3个不同附件。调用成功只表示已登记，不代表QQ已送达。最终回复描述结果，不要把本机路径当作已经发送。',
    parameters: {
      path: { type: 'string', required: true, description: '当前工作生成或选定的现有普通文件路径。' },
      kind: { type: 'string', enum: ['image', 'file'], description: '图片或文件；省略时自动识别。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      options.assertLease();
      if (exec.agent !== agent || exec.signal.aborted || typeof args.path !== 'string' || args.path.length < 1
        || args.path.length > 4096 || /[\x00-\x1f\x7f]/.test(args.path)
        || args.kind !== undefined && args.kind !== 'image' && args.kind !== 'file') throw new TypeError('Invalid work attachment request');
      const fs = agent.ctx.get('fs');
      const workingDirectory = agent.ctx.get('workingDirectory');
      const attachments = agent.ctx.get('attachments');
      if (!fs || !workingDirectory || !attachments) throw new TypeError('Work filesystem or attachment storage is unavailable');
      const cwd = await workingDirectory.ensure(agent, exec.signal);
      const entry = await fs.lstat(args.path, { cwd }, exec.signal);
      if (entry?.type !== 'file') throw new TypeError('Work attachments require an existing regular file');
      const target = await fs.resolve(args.path, { cwd, signal: exec.signal });
      const info = await fs.stat(target, exec.signal);
      if (info?.type !== 'file' || info.size !== undefined && (info.size < 1 || info.size > 8 * 1024 * 1024))
        throw new TypeError('Work attachment must be a nonempty file of at most 8MiB');
      const data = await fs.readBytes(target, exec.signal, 8 * 1024 * 1024);
      options.assertLease(); exec.signal.throwIfAborted();
      if (data.length < 1 || data.length > 8 * 1024 * 1024) throw new TypeError('Work attachment size is unsupported');
      const current = await fs.stat(target, exec.signal);
      if (current?.type !== 'file' || current.version !== info.version) throw new TypeError('Work attachment changed during reading');
      const name = basename(target.displayPath).replace(/[/\\\p{Cc}]/gu, '-').slice(0, 160);
      if (!name) throw new TypeError('Work attachment has no valid display name');
      const mediaType = imageType(data);
      if (args.kind === 'image' && !mediaType) throw new TypeError('Work image must be PNG, JPEG, WebP or GIF');
      let asset: WorkMediaReference;
      if (args.kind !== 'file' && mediaType === 'image/gif') {
        // saveImage normalizes the raster and can discard animation. Validate through the SDK,
        // but persist GIFs verbatim and retain image delivery semantics in the work reference.
        const bytes = Buffer.from(data);
        if (bytes.length < 13) throw new TypeError('Work GIF header is incomplete');
        const width = bytes.readUInt16LE(6);
        const height = bytes.readUInt16LE(8);
        if (width < 1 || width > 32768 || height < 1 || height > 32768) throw new TypeError('Work GIF dimensions are unsupported');
        await attachments.validateImage({ data, mediaType, name });
        options.assertLease(); exec.signal.throwIfAborted();
        const ref = await attachments.saveFile({ data, name });
        if (ref.bytes !== data.byteLength) throw new TypeError('Stored work GIF size changed');
        asset = { type: 'media-reference', kind: 'image', attachmentId: ref.attachmentId, bytes: ref.bytes,
          name: ref.name, mediaType, width, height };
      } else if (args.kind !== 'file' && mediaType) {
        const ref = await attachments.saveImage({ data, mediaType, name });
        asset = { type: 'media-reference', kind: 'image', attachmentId: ref.attachmentId, bytes: ref.bytes,
          name: ref.name ?? name, mediaType: ref.mediaType, width: ref.width, height: ref.height };
      } else {
        const ref = await attachments.saveFile({ data, name });
        asset = { type: 'media-reference', kind: 'file', attachmentId: ref.attachmentId, bytes: ref.bytes, name: ref.name };
      }
      options.assertLease(); exec.signal.throwIfAborted();
      if (!validWorkOutput(asset)) throw new TypeError('Stored work attachment exceeds delivery limits');
      options.commit(asset);
      return { registered: true, sent: false, kind: asset.kind, name: asset.name ?? null, bytes: asset.bytes };
    },
  }));
}
