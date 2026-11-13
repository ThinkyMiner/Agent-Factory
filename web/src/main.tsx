import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { Layout, applyTheme } from './components/Layout'
import { ControlRoom } from './pages/ControlRoom'
import { Board } from './pages/Board'
import { Item } from './pages/Item'
import { Empty } from './components/States'

try {
  const t = localStorage.getItem('cr-theme')
  applyTheme(t === 'light' || t === 'dark' ? t : 'system')
} catch {
  applyTheme('system')
}

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
      { path: '*', element: <div className="p-5"><Empty title="Nothing here">That page does not exist.</Empty></div> },
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
