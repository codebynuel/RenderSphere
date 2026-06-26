import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Plus, ChevronDown, Check, LogIn, Settings } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function TeamSwitcher() {
    const { user, activeTeamId, setActiveTeamId } = useAuth();
    const [teams, setTeams] = useState([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
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

    useEffect(() => {
        if (!user?.id) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadTeams();
    }, [user?.id]);

    // Reload team list when teams change in the Dashboard (create/join/manage)
    useEffect(() => {
        const handleTeamsChanged = () => loadTeams();
        window.addEventListener('teams-changed', handleTeamsChanged);
        return () => window.removeEventListener('teams-changed', handleTeamsChanged);
    }, []);

    const handleSelectTeam = (teamId) => {
        setActiveTeamId(teamId);
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

    const handleOpenCreate = () => {
        setOpen(false);
        window.dispatchEvent(new CustomEvent('open-create-team'));
    };

    const handleOpenJoin = () => {
        setOpen(false);
        window.dispatchEvent(new CustomEvent('open-join-team'));
    };

    const handleManageTeam = (teamId) => {
        setOpen(false);
        window.dispatchEvent(new CustomEvent('manage-team', { detail: { teamId } }));
    };

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
                    {activeTeam ? activeTeam.name : activeTeamId ? 'Loading...' : 'Personal'}
                </span>
                <ChevronDown size={14} className={open ? 'rotated' : ''} />
            </button>

            {open && (
                <div className="team-switcher-dropdown" role="listbox" aria-label="Select team">
                    <div className="team-switcher-header">
                        <span className="team-switcher-title">Team context</span>
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

                    <div className="team-switcher-footer">
                        <button className="team-switcher-action" type="button" onClick={handleOpenCreate}>
                            <Plus size={14} /> New team
                        </button>
                        <button className="team-switcher-action" type="button" onClick={handleOpenJoin}>
                            <LogIn size={14} /> Join team
                        </button>
                        {activeTeam && (
                            <button className="team-switcher-action" type="button" onClick={() => handleManageTeam(activeTeam.id)}>
                                <Settings size={14} /> Manage team
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}