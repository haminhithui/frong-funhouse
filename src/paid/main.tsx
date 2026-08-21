import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PaidApp from './PaidApp'
import '../styles/tokens.css'
import '../styles/base.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <PaidApp />
  </StrictMode>,
)
