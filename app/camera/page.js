import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken, COOKIE } from '../../lib/auth';
import CameraClient from './CameraClient';

export default function CameraPage() {
  const token = cookies().get(COOKIE)?.value;
  const session = verifyToken(token);
  if (!session) redirect('/');
  return <CameraClient user={session.u} />;
}
