import React, { useEffect, useState } from 'react';
import API from '../api';
import { useConfirm } from '../ConfirmContext';
import LeaveForm from './LeaveForm';

export default function ManagerDashboard({ user }) {
  const [leaves, setLeaves] = useState([]);
  const [accrual, setAccrual] = useState(null);
  const [showApply, setShowApply] = useState(false);
  const confirm = useConfirm();

  const load = async () => {
    try {
      const res = await API.get('/leaves/dashboard');
      setLeaves(res.data.leaves || []);
      setAccrual(res.data.accrual || null);
    } catch (e) {
      console.error('Failed to load manager dashboard', e);
    }
  };

  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    try {
      const prompt = action === 'decline' ? 'Decline this request?' : 'Approve this request?';
      let ok = true;
      if (confirm) ok = await confirm({ title: action === 'decline' ? 'Decline' : 'Approve', message: prompt });
      if (!ok) return;
      await API.post(`/leaves/${id}/${action}`);
      load();
    } catch (e) {
      console.error('Action failed', e);
    }
  };

  const viewSickNote = async (id) => {
    try {
      const res = await API.get(`/leaves/${id}/sicknote`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(res.data);
      window.open(url, '_blank');
    } catch (e) {
      console.error('Failed to open sick note', e);
      try { alert(e.response?.data?.msg || 'Failed to open sick note'); } catch (er) {}
    }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h5 className="mb-0">Manager Dashboard — Department: {user.department}</h5>
          <div className="small text-muted">Your balances</div>
        </div>
        <div>
          <button className="btn btn-sm btn-outline-primary" onClick={() => setShowApply(!showApply)}>{showApply ? 'Close Apply' : 'Apply Leave'}</button>
        </div>
      </div>
      {showApply && <LeaveForm onApplied={() => { setShowApply(false); load(); }} />}
      {accrual && (
        <div className="row mb-3">
          <div className="col-12 col-md-6">
            <div className="card shadow-sm">
              <div className="card-body">
                <div className="small text-muted">Annual Remaining</div>
                <div className="fw-bold">{accrual?.annual?.remaining ?? '-'}</div>
              </div>
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card shadow-sm">
              <div className="card-body">
                <div className="small text-muted">Sick Remaining</div>
                <div className="fw-bold">{accrual?.sick?.remaining ?? '-'}</div>
              </div>
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card shadow-sm">
              <div className="card-body">
                <div className="small text-muted">Family Remaining</div>
                <div className="fw-bold">{accrual?.family?.remaining ?? '-'}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="row">
        {leaves.length === 0 && <div className="text-muted">No requests</div>}
        {leaves.map(l => (
          <div key={l._id} className="col-12 col-md-6 card-list-item">
            <div className="card shadow-sm">
              <div className="card-body">
                <div className="d-flex w-100 justify-content-between align-items-center">
                  <h6 className="mb-1">{l.applicant?.name}</h6>
                  {(() => {
                      const s = (l.status || '').toLowerCase();
                      const cls = s === 'pending' ? 'status-badge pending' : s === 'declined' ? 'status-badge declined' : s === 'approved' ? 'status-badge approved' : 'status-badge other';
                      const ico = s === 'pending' ? 'bi-clock' : s === 'declined' ? 'bi-x-circle' : s === 'approved' ? 'bi-check-circle' : 'bi-info-circle';
                      return <span className={cls}><i className={`bi ${ico} me-1`}></i>{l.status}</span>;
                    })()}
                </div>
                <p className="mb-1">{l.type} — {new Date(l.startDate).toDateString()} to {new Date(l.endDate).toDateString()}</p>
                <p className="mb-2"><small className="text-muted">Reason: {l.reason}</small></p>
                {l.sickNote && (
                  <p className="mb-2"><a href="#" onClick={(e) => { e.preventDefault(); viewSickNote(l._id); }}>View sick note</a></p>
                )}
                          {l.status === 'Pending' && (() => {
                            const applicantId = l.applicant ? (l.applicant._id || l.applicant.id || l.applicant) : null;
                            const currentUserId = user._id || user.id;
                            const isSelf = applicantId && currentUserId && String(applicantId) === String(currentUserId);
                            if (isSelf) return null;
                            return (
                              <div className="d-flex flex-column flex-sm-row gap-2">
                                <button className="btn btn-sm btn-success btn-full-sm" onClick={() => act(l._id, 'approve')}><i className="bi bi-check-lg me-1"></i>Approve</button>
                                <button className="btn btn-sm btn-danger btn-full-sm" onClick={() => act(l._id, 'decline')}><i className="bi bi-x-lg me-1"></i>Decline</button>
                              </div>
                            );
                          })()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
