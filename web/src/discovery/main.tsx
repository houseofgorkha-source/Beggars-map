import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DiscoveryApp from './DiscoveryApp';
import './discovery.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DiscoveryApp />
  </StrictMode>
);
