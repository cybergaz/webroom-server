import Elysia, { t } from 'elysia';

const AIEXCH_BASE = 'https://api.aiexch.com';

async function proxyGet(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`Upstream error ${res.status}`), { status: 502 });
  return res.json();
}

export const sportsRoute = new Elysia({ prefix: '/sports' })

  // Competitions list (getAllSeries)
  .get('/series', () => proxyGet(`${AIEXCH_BASE}/api/sports/getAllSeries/4`))

  // Events for a competition
  .get(
    '/competitions/:id',
    ({ params }) => proxyGet(`${AIEXCH_BASE}/Soe81s9017b44b6d822da257xk055b11/sports/competitions/${params.id}`),
    { params: t.Object({ id: t.String() }) },
  )

  // Event details + market catalogues
  .get(
    '/events/:id',
    ({ params }) => proxyGet(`${AIEXCH_BASE}/Soe81s9017b44b6d822da257xk055b11/sports/events/${params.id}`),
    { params: t.Object({ id: t.String() }) },
  )

  // Live order book / odds
  .get(
    '/books/:id',
    ({ params }) => proxyGet(`${AIEXCH_BASE}/Soe81s9017b44b6d822da257xk055b11/sports/books/${params.id}`),
    { params: t.Object({ id: t.String() }) },
  );
