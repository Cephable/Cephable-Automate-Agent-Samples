import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Cephable · AI SDK agent loop',
    description: "The Vercel AI SDK's tool loop running on Cephable's on-device model",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
