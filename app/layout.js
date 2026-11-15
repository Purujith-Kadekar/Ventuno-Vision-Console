import './globals.css';

export const metadata = {
  title: 'Ventuno Vision',
  description: 'Camera and vision console for the Ventuno Q desk assistant',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
