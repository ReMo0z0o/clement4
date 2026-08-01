import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Castle Siege',
  description:
    'Un joueur piège son château, l’autre s’y infiltre. Duel asymétrique à deux, dans le navigateur.',
};

export const viewport: Viewport = {
  themeColor: '#14100c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" data-role="castellan">
      <body className="antialiased">{children}</body>
    </html>
  );
}
