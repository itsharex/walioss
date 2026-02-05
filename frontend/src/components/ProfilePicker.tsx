import { useEffect, useMemo, useRef, useState } from 'react';
import { main } from '../../wailsjs/go/models';

type ProfileOption =
  | { kind: 'none'; value: ''; label: string; subtitle?: string }
  | { kind: 'profile'; value: string; label: string; subtitle?: string; isDefault: boolean };

export default function ProfilePicker({
  profiles,
  value,
  onChange,
  placeholder = 'Select a profile…',
}: {
  profiles: main.OSSProfile[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => profiles.find((p) => p.name === value) || null, [profiles, value]);

  const options = useMemo((): ProfileOption[] => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? profiles.filter((p) => (p.name || '').toLowerCase().includes(q))
      : profiles;

    const none: ProfileOption = { kind: 'none', value: '', label: 'New connection', subtitle: 'Fill in credentials below' };
    const items: ProfileOption[] = filtered.map((p) => ({
      kind: 'profile',
      value: p.name,
      label: p.name,
      subtitle: p.isDefault ? 'Default' : undefined,
      isDefault: !!p.isDefault,
    }));
    return [none, ...items];
  }, [profiles, query]);

  const openPicker = () => {
    setOpen(true);
    setQuery('');
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  const closePicker = () => {
    setOpen(false);
    setQuery('');
    setTimeout(() => buttonRef.current?.focus(), 0);
  };

  const commit = (next: string) => {
    onChange(next);
    closePicker();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      closePicker();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const title = selected ? selected.name : '';
  const subtitle = selected ? (selected.isDefault ? 'Default profile' : 'Saved profile') : 'Choose a saved profile';

  return (
    <div className={`profile-picker ${open ? 'open' : ''}`} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="profile-picker-btn"
        onClick={() => (open ? closePicker() : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="profile-picker-main">
          <div className="profile-picker-title">{title || placeholder}</div>
          <div className="profile-picker-subtitle">{subtitle}</div>
        </div>
        <div className="profile-picker-right">
          {selected?.isDefault && <span className="profile-badge">Default</span>}
          <span className="profile-picker-chevron" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </span>
        </div>
      </button>

      {open && (
        <div className="profile-picker-popover" role="listbox" aria-label="Profiles">
          <div className="profile-picker-search">
            <input
              ref={searchRef}
              className="profile-picker-search-input"
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder="Search profiles…"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(options.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const opt = options[activeIndex];
                  if (opt) commit(opt.value);
                }
              }}
            />
            {query.trim() && (
              <button className="profile-picker-clear" type="button" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="profile-picker-list">
            {options.length === 1 ? (
              <div className="profile-picker-empty">No profiles</div>
            ) : (
              options.map((opt, idx) => (
                <button
                  key={opt.kind === 'none' ? '__none' : opt.value}
                  type="button"
                  className={`profile-picker-item ${idx === activeIndex ? 'active' : ''} ${opt.value === value ? 'selected' : ''}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => commit(opt.value)}
                  role="option"
                  aria-selected={opt.value === value}
                >
                  <div className="profile-picker-item-main">
                    <div className="profile-picker-item-name">{opt.label}</div>
                    {opt.subtitle && <div className="profile-picker-item-sub">{opt.subtitle}</div>}
                  </div>
                  {opt.kind === 'profile' && opt.isDefault && <span className="profile-badge small">Default</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

