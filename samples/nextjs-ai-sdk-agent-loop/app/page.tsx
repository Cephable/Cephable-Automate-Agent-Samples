import { Agent } from '@/components/Agent';

export default function Page() {
    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-5 py-8">
            <header className="mb-6">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
                    AI SDK tool loop &middot; on-device model
                </p>
                <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">
                    Support desk
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                    The loop, the tools and the approval policy live in this app. Cephable is the
                    model behind them, running on this machine. Try{' '}
                    <em className="not-italic font-semibold text-slate-800">
                        &ldquo;why is A-1043 late, and refund it if it&rsquo;s our fault&rdquo;
                    </em>
                    .
                </p>
            </header>
            <Agent />
        </main>
    );
}
