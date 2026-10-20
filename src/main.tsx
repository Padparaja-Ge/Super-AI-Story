import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {LocalRoomRewrite} from './LocalRoomRewrite';
import '@fontsource-variable/manrope';
import './styles.css';
import './multiplayer.css';
import './layout-fixes.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash==='#room-rewrite'?<LocalRoomRewrite/>:<App/>}</React.StrictMode>);
