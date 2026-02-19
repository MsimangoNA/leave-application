import React, { useEffect, useState } from 'react';
import API from '../api';
import { useToast } from '../ToastContext';
import { useConfirm } from '../ConfirmContext';

export default function AdminDashboard({ user }) {
  const [leaves, setLeaves] = useState([]);
  const showToast = useToast();
  const confirm = useConfirm();

  const load = async () => {
    try {
      const res = await API.get('/leaves/dashboard');
      setLeaves(res.data.leaves || []);
    } catch (e) {
      console.error('Failed to load admin dashboard', e);
    }
  };

  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    try {
      const ok = await confirm({ title: action === 'decline' ? 'Decline' : 'Approve', message: action === 'decline' ? 'Decline this request?' : 'Approve this request?' });
      if (!ok) return;
      await API.post(`/leaves/${id}/${action}`);
      showToast(`${action === 'approve' ? 'Approved' : 'Declined'}`, 'success');
      load();
    } catch (e) {
      console.error('Action failed', e);
      showToast('Action failed', 'error');
    }
  };

  const escalate = async (id) => {
    try {
      const ok = await confirm({ title: 'Escalate Leave', message: 'Send escalation for this request?' });
      if (!ok) return;
      await API.post(`/leaves/${id}/escalate`);
      showToast('Escalation sent', 'success');
      load();
    } catch (e) {
      console.error('Escalation failed', e);
      showToast('Escalation failed', 'error');
    }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0">Admin Dashboard</h5>
        <div>
          <button className="btn btn-sm btn-outline-secondary me-2" onClick={async () => {
            try {
              const res = await API.get('/leaves/reports/excel', { responseType: 'blob' });
              const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `leave-report-${Date.now()}.xlsx`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              window.URL.revokeObjectURL(url);
            } catch (e) { console.error('Export failed', e); }
          }}><i className="bi bi-file-earmark-excel me-1"></i>Export Excel</button>

          <button className="btn btn-sm btn-outline-secondary" onClick={async () => {
            try {
              const res = await API.get('/leaves/reports/pdf', { responseType: 'blob' });
              const blob = new Blob([res.data], { type: 'application/pdf' });
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `leave-report-${Date.now()}.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              window.URL.revokeObjectURL(url);
            } catch (e) { console.error('Export failed', e); }
          }}><i className="bi bi-file-earmark-pdf me-1"></i>Export PDF</button>
        </div>
      </div>
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
                {l.status === 'Pending' && (
                  <div className="d-flex flex-column flex-sm-row gap-2">
                    <button className="btn btn-sm btn-success btn-full-sm" onClick={() => act(l._id, 'approve')}><i className="bi bi-check-lg me-1"></i>Approve</button>
                    <button className="btn btn-sm btn-danger btn-full-sm" onClick={() => act(l._id, 'decline')}><i className="bi bi-x-lg me-1"></i>Decline</button>
                    <button className="btn btn-sm btn-outline-primary btn-full-sm" onClick={() => escalate(l._id)}><i className="bi bi-arrow-up-right-circle me-1"></i>Escalate</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
