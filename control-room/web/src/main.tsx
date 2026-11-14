import { StrictMode, lazy, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { Layout, PageHeader } from './components/Layout'
import { applyTheme } from './lib/theme'
import { ControlRoom } from './pages/ControlRoom'
import { Board } from './pages/Board'
import { Empty } from './components/States'

// the first screens load at once; the rest when first opened
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })))
const Item = page(() => import('./pages/Item'), 'Item')
const Runs = page(() => import('./pages/Runs'), 'Runs')
const Quality = page(() => import('./pages/Quality'), 'Quality')
const Memory = page(() => import('./pages/Memory'), 'Memory')
const Improvement = page(() => import('./pages/Improvement'), 'Improvement')
const FactoryConfig = page(() => import('./pages/FactoryConfig'), 'FactoryConfig')
const Audits = page(() => import('./pages/Audits'), 'Audits')

applyTheme()

const queryClient = new QueryClient({
  // freshness comes from the server's change stream, not from polling
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
})

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ControlRoom /> },
      { path: '/board', element: <Board /> },
      { path: '/items/:id/:tab?', element: <Item /> },
      { path: '/runs', element: <Runs /> },
      { path: '/quality', element: <Quality /> },
      { path: '/memory/:tab?', element: <Memory /> },
      { path: '/improvement', element: <Improvement /> },
      { path: '/factory', element: <FactoryConfig /> },
      { path: '/audits/:date?', element: <Audits /> },
      { path: '*', element: <><PageHeader title="Not found" /><div className="p-5"><Empty title="Nothing here">That page does not exist.</Empty></div></> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
