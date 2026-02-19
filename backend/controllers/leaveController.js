const Leave = require('../models/Leave');
const User = require('../models/User');
const Notification = require('../models/Notification');
const mailer = require('../utils/mailer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const stream = require('stream');

function monthsBetween(a, b) {
  const years = b.getFullYear() - a.getFullYear();
  const months = b.getMonth() - a.getMonth();
  return years * 12 + months;
}

// return entitlements and remaining for annual, sick and family
async function calculateAccrued(user) {
  const DEFAULT_ANNUAL = 18;
  const DEFAULT_SICK = 30;
  const DEFAULT_FAMILY = 3;
  let annualAccrued = DEFAULT_ANNUAL;
  try {
    if (user && user.hireDate) {
      const months = monthsBetween(new Date(user.hireDate), new Date());
      annualAccrued = Math.min(DEFAULT_ANNUAL, months * 1.5);
      if (!Number.isFinite(annualAccrued)) annualAccrued = DEFAULT_ANNUAL;
    }
  } catch (e) {
    annualAccrued = DEFAULT_ANNUAL;
  }

  // sum approved days by type
  const takenAgg = await Leave.aggregate([
    { $match: { applicant: user._id, status: 'Approved' } },
    { $group: { _id: '$type', total: { $sum: '$days' } } }
  ]);
  const takenMap = {};
  for (const t of takenAgg) takenMap[t._id] = t.total || 0;

  // compute remaining values based on accruals and approved taken days
  // Annual: accumulative based on hireDate => accrued = months * 1.5 (capped at DEFAULT_ANNUAL)
  // remaining may be negative if taken > accrued (or if hired recently)
  const annualTaken = takenMap['annual'] || 0;
  const annualRemaining = annualAccrued - annualTaken;

  const sickEnt = typeof user.sickEntitlement === 'number' ? user.sickEntitlement : DEFAULT_SICK;
  const sickTaken = takenMap['sick'] || 0;
  const sickRemaining = sickEnt - sickTaken;

  const familyEnt = typeof user.familyEntitlement === 'number' ? user.familyEntitlement : DEFAULT_FAMILY;
  const familyTaken = takenMap['family'] || 0;
  const familyRemaining = familyEnt - familyTaken;

  return {
    annual: { accrued: annualAccrued, taken: annualTaken, remaining: annualRemaining },
    sick: { entitlement: sickEnt, taken: sickTaken, remaining: sickRemaining },
    family: { entitlement: familyEnt, taken: familyTaken, remaining: familyRemaining }
  };
}

exports.applyLeave = async (req, res) => {
  try {
    const { type, startDate, endDate, reason } = req.body;
    const start = new Date(startDate);
    const end = new Date(endDate);
    // disallow start dates that are today or in the past
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const today = new Date();
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (startDay <= todayDay) return res.status(400).json({ msg: 'Start date must be after today' });
    // count weekdays only (exclude Saturday=6 and Sunday=0)
    function countWeekdays(sDate, eDate) {
      const s = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate());
      const e = new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate());
      if (e < s) return 0;
      let count = 0;
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) count++;
      }
      return count;
    }

    const days = countWeekdays(start, end);
    if (days <= 0) return res.status(400).json({ msg: 'Invalid dates (no weekdays in range)' });
    const actingUser = req.user;
    // support applying on behalf of another user when acting user is HR/manager/admin
    let applicant = actingUser;
    if (req.body.applicantId) {
      // only hr, manager or admin may apply for others
      if (!['hr', 'manager', 'admin'].includes(actingUser.role)) return res.status(403).json({ msg: 'Forbidden to apply on behalf' });
      const target = await User.findById(req.body.applicantId);
      if (!target) return res.status(404).json({ msg: 'Applicant not found' });
      // managers may only apply for their direct reports
      if (actingUser.role === 'manager' && String(target.manager) !== String(actingUser._id)) return res.status(403).json({ msg: 'Not manager of applicant' });
      applicant = target;
    }
    // fetch fresh applicant doc to get stored remaining/entitlement
    const dbUser = await User.findById(applicant._id);
    const accrual = await calculateAccrued(dbUser || applicant);
    // check entitlement by type
    if (type === 'annual' && days > accrual.annual.remaining) return res.status(400).json({ msg: 'Not enough annual leave remaining', remaining: accrual.annual.remaining });
    if (type === 'sick' && days > accrual.sick.remaining) return res.status(400).json({ msg: 'Not enough sick leave remaining', remaining: accrual.sick.remaining });
    if (type === 'family' && days > accrual.family.remaining) return res.status(400).json({ msg: 'Not enough family responsibility leave remaining', remaining: accrual.family.remaining });

    const leave = new Leave({ applicant: applicant._id, type, startDate: start, endDate: end, days, reason: reason || `${type} leave`, department: dbUser ? dbUser.department : applicant.department, manager: dbUser ? dbUser.manager : applicant.manager });
    await leave.save();
    // decrement stored remaining for annual leaves (persist entitlement)
    if (dbUser) {
      try {
        if (type === 'annual') {
          dbUser.annualRemaining = (typeof dbUser.annualRemaining === 'number' ? dbUser.annualRemaining : dbUser.annualEntitlement || 18) - days;
        }
        if (type === 'sick') {
          dbUser.sickRemaining = (typeof dbUser.sickRemaining === 'number' ? dbUser.sickRemaining : dbUser.sickEntitlement || 30) - days;
        }
        if (type === 'family') {
          dbUser.familyRemaining = (typeof dbUser.familyRemaining === 'number' ? dbUser.familyRemaining : dbUser.familyEntitlement || 3) - days;
        }
        await dbUser.save();
      } catch (e) { console.error('Failed to update remaining on apply:', e); }
    }
    // notify manager (email + in-app notification)
    if (applicant.manager) {
      const manager = await User.findById(applicant.manager);
      if (manager) {
        const who = (actingUser._id && String(actingUser._id) !== String(applicant._id)) ? ` on behalf of ${applicant.name} by ${actingUser.name}` : '';
        mailer.sendMail(manager.email, 'Leave application pending', `Employee ${applicant.name} applied for leave (${type}) from ${start.toDateString()} to ${end.toDateString()} (${days} days)${who}.`);
        await Notification.create({ user: manager._id, type: 'leave_pending', message: `Employee ${applicant.name} applied for ${type} leave (${days} days)${who}.`, link: `/leaves/${leave._id}` });
      }
    }
    // also notify HR users in-app so HR sees pending counts
    const hrUsersApply = await User.find({ role: 'hr' });
    for (const h of hrUsersApply) {
      await Notification.create({ user: h._id, type: 'leave_pending', message: `New leave pending: ${applicant.name} applied for ${type} (${days} days).`, link: `/leaves/${leave._id}` });
    }
    // notify applicant (if applied on behalf, inform them)
    if (actingUser._id && String(actingUser._id) !== String(applicant._id)) {
      mailer.sendMail(applicant.email, 'Leave applied on your behalf', `A leave (${type}) from ${start.toDateString()} to ${end.toDateString()} (${days} days) was applied on your behalf by ${actingUser.name}.`);
      await Notification.create({ user: applicant._id, type: 'leave_applied_on_behalf', message: `A leave (${type}) was applied on your behalf by ${actingUser.name}.`, link: `/leaves/${leave._id}` });
    }

    res.json({ leave });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};

exports.approveLeave = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id).populate('applicant');
    if (!leave) return res.status(404).json({ msg: 'Leave not found' });
    // managers cannot approve/decline their own leave — admin must handle it
    if (String(req.user._id) === String(leave.applicant._id) && req.user.role === 'manager') {
      return res.status(403).json({ msg: 'Managers cannot approve their own leave; admin approval required' });
    }
    // if applicant is manager or hr, only admin can approve
    const applicantRole = leave.applicant.role || (leave.applicant.role === undefined && (await User.findById(leave.applicant._id || leave.applicant)).role);
    if (applicantRole === 'manager' || applicantRole === 'hr' || applicantRole === 'admin') {
      if (req.user.role !== 'admin') return res.status(403).json({ msg: 'Only admin can approve manager/HR/admin leave' });
    } else {
      // applicant is likely an employee — allow manager (if manager of applicant), hr, or admin
      if (req.user.role === 'manager') {
        if (String(leave.manager) !== String(req.user._id) && leave.applicant.manager && String(leave.applicant.manager) !== String(req.user._id)) return res.status(403).json({ msg: 'Not the manager for this employee' });
      } else if (req.user.role !== 'hr' && req.user.role !== 'admin') {
        return res.status(403).json({ msg: 'Forbidden' });
      }
    }
    // check remaining for the type requested
    const accrual = await calculateAccrued(leave.applicant);
    if (leave.type === 'annual' && leave.days > accrual.annual.remaining) return res.status(400).json({ msg: 'Not enough annual leave remaining' });
    if (leave.type === 'sick' && leave.days > accrual.sick.remaining) return res.status(400).json({ msg: 'Not enough sick leave remaining' });
    if (leave.type === 'family' && leave.days > accrual.family.remaining) return res.status(400).json({ msg: 'Not enough family leave remaining' });
    leave.status = 'Approved';
    await leave.save();
    // notify employee (email + in-app) and HR (email + in-app)
    mailer.sendMail(leave.applicant.email, 'Leave approved', `Your leave (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()} was approved.`);
    await Notification.create({ user: leave.applicant._id, type: 'leave_approved', message: `Your leave (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()} was approved.`, link: `/leaves/${leave._id}` });
    if (process.env.HR_EMAIL) mailer.sendMail(process.env.HR_EMAIL, 'Leave approved', `Leave for ${leave.applicant.name} approved by ${req.user.name}.`);
    // notify all HR users in-app
    const hrUsers = await User.find({ role: 'hr' });
    for (const h of hrUsers) {
      await Notification.create({ user: h._id, type: 'leave_approved', message: `Leave for ${leave.applicant.name} was approved by ${req.user.name}.`, link: `/leaves/${leave._id}` });
    }
    res.json({ leave });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};

exports.declineLeave = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id).populate('applicant');
    if (!leave) return res.status(404).json({ msg: 'Leave not found' });
    // managers cannot approve/decline their own leave — admin must handle it
    if (String(req.user._id) === String(leave.applicant._id) && req.user.role === 'manager') {
      return res.status(403).json({ msg: 'Managers cannot decline their own leave; admin action required' });
    }
    // determine permissions: admin can decline any; if applicant is manager/hr only admin can decline
    const applicantRoleD = leave.applicant.role || (leave.applicant.role === undefined && (await User.findById(leave.applicant._id || leave.applicant)).role);
    if (applicantRoleD === 'manager' || applicantRoleD === 'hr' || applicantRoleD === 'admin') {
      if (req.user.role !== 'admin') return res.status(403).json({ msg: 'Only admin can decline manager/HR/admin leave' });
    } else {
      if (req.user.role === 'manager') {
        if (String(leave.manager) !== String(req.user._id) && leave.applicant.manager && String(leave.applicant.manager) !== String(req.user._id)) return res.status(403).json({ msg: 'Not the manager for this employee' });
      } else if (req.user.role !== 'hr' && req.user.role !== 'admin') {
        return res.status(403).json({ msg: 'Forbidden' });
      }
    }
    // if leave was pending and had an entitlement, restore the user's remaining entitlement
    if (leave.status === 'Pending') {
      try {
        const appl = await User.findById(leave.applicant._id || leave.applicant);
        if (appl) {
          if (leave.type === 'annual') {
            appl.annualRemaining = Math.min(appl.annualEntitlement || 18, (typeof appl.annualRemaining === 'number' ? appl.annualRemaining : appl.annualEntitlement || 18) + leave.days);
          }
          if (leave.type === 'sick') {
            appl.sickRemaining = Math.min(appl.sickEntitlement || 30, (typeof appl.sickRemaining === 'number' ? appl.sickRemaining : appl.sickEntitlement || 30) + leave.days);
          }
          if (leave.type === 'family') {
            appl.familyRemaining = Math.min(appl.familyEntitlement || 3, (typeof appl.familyRemaining === 'number' ? appl.familyRemaining : appl.familyEntitlement || 3) + leave.days);
          }
          await appl.save();
        }
      } catch (e) {
        console.error('Failed to restore remaining on decline:', e);
      }
    }
    leave.status = 'Declined';
    await leave.save();
    mailer.sendMail(leave.applicant.email, 'Leave declined', `Your leave (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()} was declined.`);
    await Notification.create({ user: leave.applicant._id, type: 'leave_declined', message: `Your leave (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()} was declined.`, link: `/leaves/${leave._id}` });
    if (process.env.HR_EMAIL) mailer.sendMail(process.env.HR_EMAIL, 'Leave declined', `Leave for ${leave.applicant.name} declined by ${req.user.name}.`);
    const hrUsersDecline = await User.find({ role: 'hr' });
    for (const h of hrUsersDecline) {
      await Notification.create({ user: h._id, type: 'leave_declined', message: `Leave for ${leave.applicant.name} was declined by ${req.user.name}.`, link: `/leaves/${leave._id}` });
    }
    res.json({ leave });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const user = req.user;
    if (user.role === 'employee') {
      const dbUser = await User.findById(user._id);
      const leaves = await Leave.find({ applicant: user._id }).sort({ createdAt: -1 });
      const accrual = await calculateAccrued(dbUser || user);
      const unreadNotifications = await Notification.countDocuments({ user: user._id, read: false });
      return res.json({ leaves, accrual, unreadNotifications });
    }
    if (user.role === 'manager') {
      const dbUser = await User.findById(user._id);
      const leaves = await Leave.find({ department: user.department }).populate('applicant').sort({ createdAt: -1 });
      const pendingCount = await Leave.countDocuments({ department: user.department, status: 'Pending' });
      const unreadNotifications = await Notification.countDocuments({ user: user._id, read: false });
      const accrual = await calculateAccrued(dbUser || user);
      return res.json({ leaves, pendingCount, unreadNotifications, accrual });
    }
    if (user.role === 'hr') {
      const dbUser = await User.findById(user._id);
      const leaves = await Leave.find().populate('applicant').sort({ createdAt: -1 });
      const pendingCount = await Leave.countDocuments({ status: 'Pending' });
      const unreadNotifications = await Notification.countDocuments({ user: user._id, read: false });
      const accrual = await calculateAccrued(dbUser || user);
      return res.json({ leaves, pendingCount, unreadNotifications, accrual });
    }
    if (user.role === 'admin') {
      // admin gets all data plus a small report summary
      const dbUser = await User.findById(user._id);
      const leaves = await Leave.find().populate('applicant').sort({ createdAt: -1 });
      const pendingCount = await Leave.countDocuments({ status: 'Pending' });
      const unreadNotifications = await Notification.countDocuments({ user: user._id, read: false });
      const summary = await Leave.aggregate([
        { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 }, days: { $sum: '$days' } } }
      ]);
      const accrual = await calculateAccrued(dbUser || user);
      return res.json({ leaves, pendingCount, unreadNotifications, summary, accrual });
    }
    res.status(403).json({ msg: 'Role not supported' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};

exports.getReports = async (req, res) => {
  try {
    const user = req.user;
    if (user.role !== 'admin' && user.role !== 'hr') return res.status(403).json({ msg: 'Forbidden' });
    // overall leaves list (can be filtered by query params in future)
    const leaves = await Leave.find().populate('applicant').sort({ createdAt: -1 });
    const byUser = await Leave.aggregate([
      { $group: { _id: '$applicant', totalDays: { $sum: '$days' }, count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { user: '$user.name', email: '$user.email', totalDays: 1, count: 1 } }
    ]);
    const byType = await Leave.aggregate([
      { $group: { _id: '$type', totalDays: { $sum: '$days' }, count: { $sum: 1 } } }
    ]);
    return res.json({ leaves, byUser, byType });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};

// Excel export for admin/hr
exports.getReportsExcel = async (req, res) => {
  try {
    const user = req.user;
    if (user.role !== 'admin' && user.role !== 'hr') return res.status(403).json({ msg: 'Forbidden' });
    const leaves = await Leave.find().populate('applicant').sort({ createdAt: -1 }).lean();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Leaves');
    sheet.columns = [
      { header: 'Applicant', key: 'applicant', width: 30 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Type', key: 'type', width: 15 },
      { header: 'Start', key: 'start', width: 15 },
      { header: 'End', key: 'end', width: 15 },
      { header: 'Days', key: 'days', width: 8 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Manager', key: 'manager', width: 30 },
      { header: 'Reason', key: 'reason', width: 40 },
      { header: 'Applied At', key: 'appliedAt', width: 20 }
    ];
    for (const l of leaves) {
      let managerName = '';
      try {
        if (l.manager) {
          const mgr = await User.findById(l.manager).select('name').lean();
          managerName = mgr ? mgr.name : '';
        }
      } catch (e) {
        managerName = '';
      }
      await sheet.addRow({
        applicant: l.applicant?.name || '',
        email: l.applicant?.email || '',
        type: l.type,
        start: l.startDate ? new Date(l.startDate).toLocaleDateString() : '',
        end: l.endDate ? new Date(l.endDate).toLocaleDateString() : '',
        days: l.days,
        status: l.status,
        department: l.department || '',
        manager: managerName,
        reason: l.reason || '',
        appliedAt: l.createdAt ? new Date(l.createdAt).toLocaleString() : ''
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=leave-report-${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to generate Excel');
  }
};

// PDF export for admin/hr
exports.getReportsPdf = async (req, res) => {
  try {
    const user = req.user;
    if (user.role !== 'admin' && user.role !== 'hr') return res.status(403).json({ msg: 'Forbidden' });
    const leaves = await Leave.find().populate('applicant').sort({ createdAt: -1 }).lean();
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    const passthrough = new stream.PassThrough();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=leave-report-${Date.now()}.pdf`);
    doc.pipe(passthrough);
    doc.fontSize(18).text('Leave Applications Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10);
    for (const l of leaves) {
      let managerName = '';
      try {
        if (l.manager) {
          const mgr = await User.findById(l.manager).select('name').lean();
          managerName = mgr ? mgr.name : '';
        }
      } catch (e) {
        managerName = '';
      }
      doc.fillColor('black').text(`Applicant: ${l.applicant?.name || ''} (${l.applicant?.email || ''})`, { continued: false });
      doc.text(`Type: ${l.type} — ${l.days} days — Status: ${l.status}`);
      doc.text(`Period: ${l.startDate ? new Date(l.startDate).toLocaleDateString() : ''} to ${l.endDate ? new Date(l.endDate).toLocaleDateString() : ''}`);
      doc.text(`Department: ${l.department || ''} — Manager: ${managerName}`);
      if (l.reason) doc.text(`Reason: ${l.reason}`);
      doc.text(`Applied: ${l.createdAt ? new Date(l.createdAt).toLocaleString() : ''}`);
      doc.moveDown();
      // add a horizontal rule
      doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#eeeeee').stroke();
      doc.moveDown();
    }
    doc.end();
    passthrough.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to generate PDF');
  }
};

exports.escalateLeave = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id).populate('applicant');
    if (!leave) return res.status(404).json({ msg: 'Leave not found' });
    // allow HR, manager or admin to escalate
    if (!['hr', 'manager', 'admin'].includes(req.user.role)) return res.status(403).json({ msg: 'Forbidden' });
    if (leave.status !== 'Pending') return res.status(400).json({ msg: 'Only pending leaves can be escalated' });
    // notify manager and HR
    if (leave.manager) {
      const manager = await User.findById(leave.manager);
      if (manager) {
        const subject = 'Leave escalation — please review pending application';
        const body = `Please review the pending leave application for ${leave.applicant.name} (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()} (${leave.days} days). Escalated by ${req.user.name}.`;
        mailer.sendMail(manager.email, subject, body);
        await Notification.create({ user: manager._id, type: 'leave_escalation', message: `Please review leave for ${leave.applicant.name} (${leave.type}) from ${leave.startDate.toDateString()} to ${leave.endDate.toDateString()}.`, link: `/leaves/${leave._id}` });
      }
    }
    if (process.env.HR_EMAIL) mailer.sendMail(process.env.HR_EMAIL, 'Leave escalation', `Leave for ${leave.applicant.name} has been escalated by ${req.user.name}.`);
    res.json({ msg: 'Escalation notifications sent' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};
