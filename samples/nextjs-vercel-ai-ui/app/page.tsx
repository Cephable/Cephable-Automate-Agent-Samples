import { Chat } from '@/components/Chat';

export default function Home() {
    return (
        <main className="mx-auto max-w-4xl px-4 py-8">
            <header className="mb-6">
                <h1 className="font-semibold text-2xl tracking-tight">Cephable · incident review</h1>
                <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
                    A chat UI built from Vercel&apos;s AI Elements, driving Cephable&apos;s on-device agent.
                    The tools it calls are this app&apos;s own functions, and two of them draw straight into
                    this page.
                </p>
            </header>
            <Chat />
        </main>
    );
}
