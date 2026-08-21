import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DEMO_SITE_CONFIG } from './content/site'
import './styles/tokens.css'
import './styles/base.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <App config={DEMO_SITE_CONFIG} />
  </StrictMode>,
)
