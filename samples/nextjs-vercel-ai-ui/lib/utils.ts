import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's class combiner. Every AI Elements component imports this from `@/lib/utils`. */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
