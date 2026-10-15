import {StrictMode} from 'react'; import {createRoot} from 'react-dom/client'; import {registerSW} from 'virtual:pwa-register'; import Root from './Root'; import './index.css';
registerSW({immediate:true}); createRoot(document.getElementById('root')!).render(<StrictMode><Root/></StrictMode>);
