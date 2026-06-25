import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Plus, ChevronDown, Check } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function TeamSwitcher({ activeTeamId, onTeamChange }) {
    const { user, reloadUser } = useAuth();
    const [teams, setTeams] = useState([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createError, setCreateError] = useState('');
    const ref = useRef(null);
    const buttonRef = useRef(null);

    const loadTeams = async () => {
        try {
            setLoading(true);
            const data = await api('/api/teams');
            setTeams(data.teams || []);
        } catch (error) {
            console.error('Failed to load teams:', error);
        } finally {
            setLoading(false);
        }
    };

    // Load teams on mount and when user changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!user?.id) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadTeams();
    }, [user?.id]);

    const handleCreateTeam = async (e) => {
        e.preventDefault();
        if (!createName.trim() || creating) return;
        setCreating(true);
        setCreateError('');
        try {
            const data = await api('/api/teams', {
                method: 'POST',
                body: JSON.stringify({ name: createName.trim() }),
            });
            setCreateName('');
            setCreating(false);
            setOpen(false);
            await loadTeams();
            if (data.team?.id) {
                onTeamChange(data.team.id);
            }
            await reloadUser();
        } catch (error) {
            setCreateError(error.message || 'Failed to create team');
            setCreating(false);
        }
    };

    const handleSelectTeam = (teamId) => {
        onTeamChange(teamId);
        setOpen(false);
    };

    const handleClickOutside = useCallback((event) => {
        if (ref.current && !ref.current.contains(event.target)) {
            setOpen(false);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        document.addEventListener('pointerdown', handleClickOutside);
        return () => document.removeEventListener('pointerdown', handleClickOutside);
    }, [open, handleClickOutside]);

    const activeTeam = teams.find(t => t.id === activeTeamId);

    if (teams.length === 0 && !loading) {
        return (
            <button
                ref={buttonRef}
                className="team-switcher-trigger"
                type="button"
                onClick={() => setOpen(true)}
                aria-label="Create team"
                aria-expanded={open}
            >
                <Users size={16} />
                <span>Create team</span>
                <ChevronDown size={14} />
            </button>
        );
    }

    return (
        <div className="team-switcher-wrap" ref={ref}>
            <button
                ref={buttonRef}
                className={`team-switcher-trigger${open ? ' open' : ''}`}
                type="button"
                onClick={() => setOpen(!open)}
                aria-label="Switch team"
                aria-expanded={open}
                aria-haspopup="listbox"
            >
                <Users size={16} />
                <span className="team-switcher-label">
                    {activeTeam ? activeTeam.name : 'Personal'}
                </span>
                <ChevronDown size={14} className={open ? 'rotated' : ''} />
            </button>

            {open && (
                <div className="team-switcher-dropdown" role="listbox" aria-label="Select team">
                    <div className="team-switcher-header">
                        <span className="team-switcher-title">Team context</span>
                        <button
                            className="team-switcher-create-btn"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
                        >
                            <Plus size={14} /> New team
                        </button>
                    </div>

                    <div className="team-switcher-options">
                        <button
                            className={`team-switcher-option${!activeTeamId ? ' active' : ''}`}
                            type="button"
                            role="option"
                            aria-selected={!activeTeamId}
                            onClick={() => handleSelectTeam('')}
                        >
                            <span className="team-option-info">
                                <span className="team-option-name">Personal account</span>
                                <span className="team-option-role">Your own balance</span>
                            </span>
                            {!activeTeamId && <Check size={14} className="team-option-check" />}
                        </button>

                        {loading ? (
                            <div className="team-switcher-loading">Loading teams...</div>
                        ) : teams.length === 0 ? (
                            <div className="team-switcher-empty">No teams yet</div>
                        ) : (
                            teams.map((team) => (
                                <button
                                    key={team.id}
                                    className={`team-switcher-option${team.id === activeTeamId ? ' active' : ''}`}
                                    type="button"
                                    role="option"
                                    aria-selected={team.id === activeTeamId}
                                    onClick={() => handleSelectTeam(team.id)}
                                >
                                    <span className="team-option-info">
                                        <span className="team-option-name">{team.name}</span>
                                        <span className="team-option-role">{team.role} · {team.memberCount} member{team.memberCount !== 1 ? 's' : ''}</span>
                                    </span>
                                    {team.id === activeTeamId && <Check size={14} className="team-option-check" />}
                                </button>
                            ))
                        )}
                    </div>

                    {/* Create team inline form */}
                    <form className="team-switcher-create-form" onSubmit={handleCreateTeam}>
                        <input
                            type="text"
                            className="team-switcher-create-input"
                            placeholder="Team name"
                            value={createName}
                            onChange={(e) => setCreateName(e.target.value)}
                            autoFocus
                            maxLength={80}
                        />
                        <div className="team-switcher-create-actions">
                            <button type="button" className="button" onClick={() => { setCreateName(''); setCreateError(''); setOpen(false); }}>Cancel</button>
                            <button type="submit" className="button primary" disabled={creating || !createName.trim()}>
                                {creating ? 'Creating...' : 'Create team'}
                            </button>
                        </div>
                        {createError && <p className="team-switcher-create-error">{createError}</p>}
                    </form>
                </div>
            )}
        </div>
    );
}