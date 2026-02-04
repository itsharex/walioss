import { useEffect, useMemo, useState } from 'react';
import { main } from '../../wailsjs/go/models';
import { GetObjectText, PresignObject, PutObjectText } from '../../wailsjs/go/main/OSSService';
import './FilePreviewModal.css';
import './Modal.css';

type PreviewKind = 'text' | 'image' | 'video' | 'unsupported';

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_TEXT_EDIT_BYTES = 1024 * 1024;
const MAX_HIGHLIGHT_CHARS = 300 * 1024;

const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'xml',
  'csv',
  'tsv',
  'log',
  'ini',
  'conf',
  'toml',
  'env',
  'go',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'java',
  'py',
  'rb',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
]);

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mkv']);

function getFileExtension(name: string) {
  const parts = name.split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].toLowerCase();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightText(text: string) {
  const keywords = new Set(['true', 'false', 'null', 'undefined']);
  const isWordChar = (ch: string) => /[a-zA-Z0-9_$]/.test(ch);
  const isDigit = (ch: string) => /[0-9]/.test(ch);

  let out = '';
  let i = 0;
  let state: 'normal' | 'string' | 'comment' = 'normal';
  let quote = '"';

  const open = (cls: string) => {
    out += `<span class="${cls}">`;
  };
  const close = () => {
    out += '</span>';
  };

  while (i < text.length) {
    const ch = text[i];

    if (state === 'comment') {
      if (ch === '\n') {
        close();
        out += '\n';
        state = 'normal';
        i += 1;
        continue;
      }
      out += escapeHtml(ch);
      i += 1;
      continue;
    }

    if (state === 'string') {
      out += escapeHtml(ch);
      if (ch === '\\' && i + 1 < text.length) {
        out += escapeHtml(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === quote) {
        close();
        state = 'normal';
      }
      i += 1;
      continue;
    }

    // normal
    if (ch === '"' || ch === "'") {
      quote = ch;
      open('token-string');
      out += escapeHtml(ch);
      state = 'string';
      i += 1;
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      open('token-comment');
      out += '//';
      state = 'comment';
      i += 2;
      continue;
    }

    if (ch === '#') {
      open('token-comment');
      out += '#';
      state = 'comment';
      i += 1;
      continue;
    }

    if (isDigit(ch) || (ch === '-' && i + 1 < text.length && isDigit(text[i + 1]))) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j += 1;
      const token = text.slice(i, j);
      open('token-number');
      out += escapeHtml(token);
      close();
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && isWordChar(text[j])) j += 1;
      const word = text.slice(i, j);
      if (keywords.has(word)) {
        open('token-keyword');
        out += escapeHtml(word);
        close();
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }

  if (state === 'comment' || state === 'string') {
    close();
  }

  return out;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${sizes[i]}`;
}

interface FilePreviewModalProps {
  isOpen: boolean;
  config: main.OSSConfig;
  bucket: string;
  object: main.ObjectInfo | null;
  onClose: () => void;
  onDownload?: (obj: main.ObjectInfo) => void;
  onSaved?: () => void;
}

export default function FilePreviewModal({ isOpen, config, bucket, object, onClose, onDownload, onSaved }: FilePreviewModalProps) {
  const [kind, setKind] = useState<PreviewKind>('unsupported');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presignedUrl, setPresignedUrl] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [originalText, setOriginalText] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [highlightHtml, setHighlightHtml] = useState<string>('');

  const fileKey = useMemo(() => {
    if (!object?.path || !bucket) return '';
    const prefix = `oss://${bucket}/`;
    return object.path.startsWith(prefix) ? object.path.slice(prefix.length) : '';
  }, [bucket, object?.path]);

  const extension = useMemo(() => (object ? getFileExtension(object.name) : ''), [object]);

  const canEditText = useMemo(() => {
    if (!object) return false;
    if (!textExtensions.has(extension) && object.name.toLowerCase() !== 'dockerfile' && object.name.toLowerCase() !== 'makefile') return false;
    return object.size <= MAX_TEXT_EDIT_BYTES;
  }, [extension, object]);

  const kindFromName = useMemo((): PreviewKind => {
    if (!object) return 'unsupported';
    const nameLower = object.name.toLowerCase();
    const ext = getFileExtension(nameLower);
    if (imageExtensions.has(ext)) return 'image';
    if (videoExtensions.has(ext)) return 'video';
    if (textExtensions.has(ext) || nameLower === 'dockerfile' || nameLower === 'makefile') return 'text';
    return 'unsupported';
  }, [object]);

  const dirty = canEditText && text !== originalText;

  useEffect(() => {
    if (!isOpen || !object) return;

    setKind(kindFromName);
    setLoading(true);
    setSaving(false);
    setError(null);
    setPresignedUrl('');
    setText('');
    setOriginalText('');
    setTruncated(false);
    setHighlightHtml('');

    const load = async () => {
      try {
        if (!fileKey) {
          setError('Invalid object path');
          setKind('unsupported');
          return;
        }

        if (kindFromName === 'image' || kindFromName === 'video') {
          const url = await PresignObject(config, bucket, fileKey, '30m');
          setPresignedUrl(url);
          return;
        }

        if (kindFromName === 'text') {
          const maxBytes = canEditText ? MAX_TEXT_EDIT_BYTES : MAX_TEXT_PREVIEW_BYTES;
          const content = await GetObjectText(config, bucket, fileKey, maxBytes);
          setText(content);
          setOriginalText(content);
          setTruncated(!!object.size && object.size > maxBytes);
          return;
        }
      } catch (err: any) {
        setError(err?.message || 'Preview failed');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [bucket, canEditText, config, fileKey, isOpen, kindFromName, object]);

  useEffect(() => {
    if (!isOpen || kind !== 'text') return;
    const timer = window.setTimeout(() => {
      const slice = text.length > MAX_HIGHLIGHT_CHARS ? text.slice(0, MAX_HIGHLIGHT_CHARS) : text;
      setHighlightHtml(highlightText(slice));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, kind, text]);

  if (!isOpen || !object) return null;

  const requestClose = () => {
    if (dirty) {
      const ok = window.confirm('You have unsaved changes. Discard them?');
      if (!ok) return;
    }
    onClose();
  };

  const handleSave = async () => {
    if (!canEditText || !fileKey) return;
    setSaving(true);
    setError(null);
    try {
      await PutObjectText(config, bucket, fileKey, text);
      setOriginalText(text);
      onSaved?.();
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const renderBody = () => {
    if (loading) {
      return (
        <div className="preview-loading">
          <div className="loading-spinner"></div>
          <p>Loading preview…</p>
        </div>
      );
    }

    if (kind === 'image') {
      return (
        <div className="preview-media">
          {presignedUrl ? (
            <img className="preview-image" src={presignedUrl} alt={object.name} />
          ) : (
            <div className="preview-empty">No preview URL</div>
          )}
        </div>
      );
    }

    if (kind === 'video') {
      return (
        <div className="preview-media">
          {presignedUrl ? (
            <video className="preview-video" src={presignedUrl} controls preload="metadata" />
          ) : (
            <div className="preview-empty">No preview URL</div>
          )}
        </div>
      );
    }

    if (kind === 'text') {
      const isHighlightTruncated = text.length > MAX_HIGHLIGHT_CHARS;
      if (!canEditText) {
        return (
          <div className="preview-text">
            {(truncated || isHighlightTruncated) && (
              <div className="preview-banner">
                {truncated ? `Preview is truncated to ${formatBytes(MAX_TEXT_PREVIEW_BYTES)}.` : 'Syntax highlighting is truncated for performance.'}
              </div>
            )}
            <pre className="preview-code">
              <code dangerouslySetInnerHTML={{ __html: highlightHtml || escapeHtml(text) }} />
            </pre>
          </div>
        );
      }

      return (
        <div className="preview-text split">
          {truncated && (
            <div className="preview-banner">
              Preview is truncated to {formatBytes(MAX_TEXT_EDIT_BYTES)}.
            </div>
          )}
          <div className="editor-split">
            <div className="editor-pane">
              <div className="pane-title">Edit</div>
              <textarea
                className="text-editor"
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="preview-pane">
              <div className="pane-title">Highlight</div>
              {text.length > MAX_HIGHLIGHT_CHARS && (
                <div className="pane-hint">Showing first {formatBytes(MAX_HIGHLIGHT_CHARS)} for performance.</div>
              )}
              <pre className="preview-code">
                <code dangerouslySetInnerHTML={{ __html: highlightHtml || escapeHtml(text) }} />
              </pre>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="preview-empty">
        <p>Preview not available for this file type.</p>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="modal-content preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <div className="preview-title">
            <div className="preview-name" title={object.name}>
              {object.name}
            </div>
            <div className="preview-subtitle">
              <span className="preview-path" title={object.path}>
                {object.path}
              </span>
              {object.size > 0 && <span className="preview-size">{formatBytes(object.size)}</span>}
            </div>
          </div>
          <div className="preview-actions">
            {kind === 'text' && canEditText && (
              <button className="preview-btn primary" onClick={handleSave} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {onDownload && (
              <button className="preview-btn" onClick={() => onDownload(object)} disabled={saving || loading}>
                Download
              </button>
            )}
            <button className="preview-btn" onClick={requestClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
        <div className="preview-body">
          {error && <div className="preview-error-banner">{error}</div>}
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
