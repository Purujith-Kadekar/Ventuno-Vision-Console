import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken, COOKIE } from '../lib/auth';
import LoginForm from './LoginForm';

export default function Home() {
  const token = cookies().get(COOKIE)?.value;
  if (verifyToken(token)) redirect('/camera');
  return <LoginForm />;
}
