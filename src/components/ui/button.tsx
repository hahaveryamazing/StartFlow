import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
const variants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      secondary: 'btn-secondary',
      ghost: 'btn-ghost',
      destructive: 'btn-danger',
    },
    size: { default: '', sm: 'btn-sm', icon: 'btn-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variants> {
  asChild?: boolean;
  loading?: boolean;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        type="button"
        className={cn(variants({ variant, size }), className)}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <LoaderCircle size={16} className="spin" />}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
