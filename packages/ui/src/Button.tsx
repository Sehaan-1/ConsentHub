import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary';
}

export function Button({
  children,
  variant = 'primary',
  className,
  ...buttonProps
}: ButtonProps) {
  const classes = ['ch-button', `ch-button--${variant}`, className]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return (
    <button className={classes} {...buttonProps}>
      {children}
    </button>
  );
}
