import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
    title: 'Cephable · on-device incident review',
    description: 'A Vercel AI Elements chat UI driving the local Cephable Automate agent',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            {/*
              `dark` is hardcoded rather than wired to a theme toggle: this is a sample, and one less
              moving part. Remove it (or drive it with next-themes) for a real app - the token set in
              globals.css defines both schemes.
            */}
            <body className="dark">
                {/* AI Elements' tool and message actions use tooltips, which need this provider. */}
                <TooltipProvider>{children}</TooltipProvider>
            </body>
        </html>
    );
}
