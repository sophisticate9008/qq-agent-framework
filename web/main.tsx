import { createRoot } from 'react-dom/client';
import { Console } from './console.tsx';
import { ThemeProvider } from './components/theme-provider.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import './console.css';

const root = document.getElementById('root');
if (!root) throw new Error('Management application root is missing.');
createRoot(root).render(<ThemeProvider><TooltipProvider><Console /></TooltipProvider></ThemeProvider>);
