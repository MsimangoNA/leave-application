const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const leaveCtrl = require('../controllers/leaveController');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

router.post('/apply', auth, upload.single('sickNote'), leaveCtrl.applyLeave);
router.get('/:id/sicknote', auth, leaveCtrl.getSickNote);
router.post('/:id/approve', auth, leaveCtrl.approveLeave);
router.post('/:id/decline', auth, leaveCtrl.declineLeave);
router.post('/:id/escalate', auth, leaveCtrl.escalateLeave);
router.get('/dashboard', auth, leaveCtrl.getDashboard);
router.get('/reports', auth, leaveCtrl.getReports);
router.get('/reports/excel', auth, leaveCtrl.getReportsExcel);
router.get('/reports/pdf', auth, leaveCtrl.getReportsPdf);

module.exports = router;
