import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './context/AuthContext';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster 
          position="bottom-right" 
          toastOptions={{
            style: {
              background: '#0c0e10',
              color: '#f6f7f4',
              border: '1px solid rgba(255, 255, 255, 0.16)',
            },
            success: {
              iconTheme: {
                primary: '#b7ffdd',
                secondary: '#0c0e10',
              },
            },
            error: {
              iconTheme: {
                primary: '#ff7b8d',
                secondary: '#0c0e10',
              },
            },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
