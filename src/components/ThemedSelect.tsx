import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(() => selectedIndex >= 0 ? selectedIndex : 0);

  const closeMenu = (restoreTriggerFocus = false) => {
    setOpen(false);
    if (restoreTriggerFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (index = selectedIndex >= 0 ? selectedIndex : 0) => {
    if (options.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setOpen(true);
  };

  const chooseOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!selectRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const focusId = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(focusId);
  }, [activeIndex, open]);

  useEffect(() => {
    if (open) return;
    setActiveIndex((current) => Math.max(0, Math.min(selectedIndex >= 0 ? selectedIndex : current, Math.max(0, options.length - 1))));
  }, [open, options.length, selectedIndex]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? Math.min(selectedIndex + 1, options.length - 1) : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? Math.max(selectedIndex - 1, 0) : options.length - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      openMenu(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu(true);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseOption(index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === 'Tab') {
      closeMenu();
    }
  };

  return <div className="sd-themed-select" ref={selectRef}>
    <button ref={triggerRef} className={`sd-themed-select-trigger ${invalid ? 'is-invalid' : ''}`} type="button" aria-label={label} aria-haspopup="listbox" aria-controls={open ? listboxId : undefined} aria-expanded={open} onClick={() => open ? closeMenu() : openMenu()} onKeyDown={handleTriggerKeyDown}>
      <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={18} />
    </button>
    {open && <div className="sd-themed-select-options" id={listboxId} role="listbox" aria-label={label}>
      {options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element; }} type="button" role="option" aria-selected={option.value === value} aria-posinset={index + 1} aria-setsize={options.length} tabIndex={index === activeIndex ? 0 : -1} className={option.value === value ? 'is-selected' : ''} key={option.value} onClick={() => chooseOption(index)} onKeyDown={(event) => handleOptionKeyDown(event, index)}>{option.label}</button>)}
    </div>}
  </div>;
}
