import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../utils/api';

function JoinTeam() {
    const { token } = useParams();
    const [status, setStatus] = useState('loading'); // loading, success, error
    const [teamName, setTeamName] = useState('');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        if (!token) {
            setStatus('error');
            setErrorMsg('No invite token provided.');
            return;
        }

        let cancelled = false;

        (async () => {
            try {
                const data = await api(`/api/teams/join/${token}`, { method: 'POST' });
                if (!cancelled) {
                    setTeamName(data.team.name);
                    setStatus('success');
                }
            } catch (error) {
                if (!cancelled) {
                    setErrorMsg(error.message || 'Failed to join team');
                    setStatus('error');
                }
            }
        })();

        return () => { cancelled = true; };
    }, [token]);

    return (
        <main className="page page-center">
            <div className="join-team-card">
                {status === 'loading' && (
                    <div className="join-team-content">
                        <Loader2 size={40} className="spin" />
                        <h2>Joining team...</h2>
                        <p className="muted">Please wait while we process your invite.</p>
                    </div>
                )}

                {status === 'success' && (
                    <div className="join-team-content">
                        <CheckCircle2 size={40} style={{ color: 'var(--green)' }} />
                        <h2>You joined {teamName}!</h2>
                        <p className="muted">You can now submit renders and collaborate with your team.</p>
                        <Link to="/app" className="button primary" style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            Go to dashboard <ArrowRight size={16} />
                        </Link>
                    </div>
                )}

                {status === 'error' && (
                    <div className="join-team-content">
                        <XCircle size={40} style={{ color: 'var(--danger)' }} />
                        <h2>Could not join team</h2>
                        <p className="muted">{errorMsg}</p>
                        <Link to="/app" className="button" style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            Go to dashboard <ArrowRight size={16} />
                        </Link>
                    </div>
                )}
            </div>

            <style>{`
                .page-center {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                    padding: 40px 20px;
                }
                .join-team-card {
                    max-width: 420px;
                    width: 100%;
                    background: var(--panel-bg);
                    border: 1px solid var(--line-soft);
                    border-radius: 18px;
                    padding: 40px 32px;
                    text-align: center;
                }
                .join-team-content {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                }
                .join-team-content h2 {
                    margin: 0;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .spin {
                    animation: spin 1s linear infinite;
                }
            `}</style>
        </main>
    );
}

export default JoinTeam;
