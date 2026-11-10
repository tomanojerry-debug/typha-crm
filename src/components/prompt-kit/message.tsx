// Adapted from ibelick/prompt-kit (MIT), copyright 2025 Julien Thibeaut.
// See third_party/prompt-kit/LICENSE and README.md.
import type { HTMLAttributes } from 'react';
export function Message({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`chat-message ${className}`} {...props} />;
}
export function MessageContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`chat-message-body ${className}`} {...props} />;
}
export function MessageActions({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`chat-message-actions ${className}`} {...props} />;
}
