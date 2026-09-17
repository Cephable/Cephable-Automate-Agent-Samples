import { Chat } from '../components/Chat';

export default function Home() {
    return (
        <main>
            <header>
                <h1>Cephable · incident review</h1>
                <p>
                    A Vercel AI SDK chat UI driving Cephable&apos;s on-device agent. The tools it calls are
                    this app&apos;s own functions, and two of them draw straight into this page.
                </p>
            </header>
            <Chat />
        </main>
    );
}
