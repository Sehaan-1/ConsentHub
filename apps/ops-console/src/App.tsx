import { useEffect, useState } from 'react';
import { Button, Card } from '@consenthub/ui';

interface HelloResponse {
  readonly message: string;
  readonly service: string;
}

export function App() {
  const [hello, setHello] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/hello')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`BFF returned HTTP ${response.status}`);
        }
        return (await response.json()) as HelloResponse;
      })
      .then(setHello)
      .catch(() => setError('The ConsentHub service is not available yet.'));
  }, []);

  return (
    <main className="page-shell">
      <p className="eyebrow">ConsentHub Operations</p>
      <h1>Keep consent flows healthy.</h1>
      <Card>
        <h2>Service status</h2>
        {hello === null && error === null && <p>Connecting to the ConsentHub API…</p>}
        {hello !== null && <p>{hello.message} ({hello.service})</p>}
        {error !== null && <p role="status">{error}</p>}
        <Button onClick={() => window.location.reload()} variant="secondary">
          Check again
        </Button>
      </Card>
    </main>
  );
}
