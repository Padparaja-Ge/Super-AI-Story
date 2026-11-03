import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {LocalRoomRewrite} from './LocalRoomRewrite';
import '@fontsource-variable/manrope';
import './styles.css';
import './multiplayer.css';
import './layout-fixes.css';
import {initializeInterfaceLanguage,useInterfaceLanguage} from './i18n';
function LocalizedApplication(){useInterfaceLanguage();return window.location.hash==='#room-rewrite'?<LocalRoomRewrite/>:<App/>;}
void initializeInterfaceLanguage();
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalizedApplication/></React.StrictMode>);
