import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import './themed-select.css';

export type ThemedSelectOption = {
  value: string;
  label: string;
};

type ThemedSelectProps = {
  value: string;
  options: ThemedSelectOption[];
  placeholder: string;
  label: string;
  invalid?: boolean;
  onChange: (value: string) => void;
};

export function ThemedSelect({ value, options, placeholder, label, invalid = false, onChange }: ThemedSelectProps) {
  const [open, setOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!selectRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return <div className="sd-themed-select" ref={selectRef}>
    <button className={`sd-themed-select-trigger ${invalid ? 'is-invalid' : ''}`} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
    }}>
      <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={18} />
    </button>
    {open && <div className="sd-themed-select-options" role="listbox" aria-label={label}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}
