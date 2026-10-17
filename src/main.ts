import './ui/style.css';
import { App } from './ui/app';

const root = document.getElementById('app')!;
const app = new App(root);
(window as unknown as { websim: App }).websim = app;
