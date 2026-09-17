import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
}

export function Card({ children, className, ...sectionProps }: CardProps) {
  const classes = ['ch-card', className]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return (
    <section className={classes} {...sectionProps}>
      {children}
    </section>
  );
}
