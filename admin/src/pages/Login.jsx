import { useState } from 'react';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await login(username, password); } catch (err) { setError(err.message.replace(/<[^>]+>/g, '')); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <div className="login-box">
        <h1>Store Admin</h1>
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        <form onSubmit={submit}>
          <label htmlFor="user">Username or Email Address</label>
          <input id="user" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          <label htmlFor="pass">Password</label>
          <input id="pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit" className="button button-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center', minHeight: 36 }}>{busy ? 'Logging in…' : 'Log In'}</button>
        </form>
      </div>
    </div>
  );
}
