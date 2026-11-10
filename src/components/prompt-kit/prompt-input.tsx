// Adapted from ibelick/prompt-kit (MIT), copyright 2025 Julien Thibeaut.
// See third_party/prompt-kit/LICENSE and README.md.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
type InputContext = {
  value: string;
  setValue: (v: string) => void;
  maxHeight: number;
  onSubmit: () => void;
  disabled: boolean;
  canSubmit: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};
const PromptInputContext = createContext<InputContext | null>(null);
function usePromptInput() {
  const context = useContext(PromptInputContext);
  if (!context) throw new Error('PromptInput components must be used within PromptInput');
  return context;
}
export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  disabled = false,
  canSubmit = true,
  maxHeight = 220,
  children,
  className = '',
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  canSubmit?: boolean;
  maxHeight?: number;
  children: ReactNode;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <PromptInputContext.Provider
      value={{
        value,
        setValue: onValueChange,
        maxHeight,
        onSubmit,
        disabled,
        canSubmit,
        textareaRef,
      }}
    >
      <form
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && canSubmit) onSubmit();
        }}
      >
        {children}
      </form>
    </PromptInputContext.Provider>
  );
}
export function PromptInputTextarea({
  onKeyDown,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { value, setValue, maxHeight, onSubmit, disabled, canSubmit, textareaRef } =
    usePromptInput();
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight, textareaRef]);
  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!disabled && canSubmit) onSubmit();
        }
      }}
    />
  );
}
export function PromptInputActions({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={className} {...props} />;
}
