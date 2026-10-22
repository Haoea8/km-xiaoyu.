/**
 * 收货地址 / 交易地点管理
 */
const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    list: [],
    /** 编辑面板 */
    showEdit: false,
    editing: null,
    form: { name: '', phone: '', campus: '', detail: '', isDefault: false },
    saving: false
  },

  onLoad() { this.fetch(); },
  onShow() { if (!this.data.loading) this.fetch(); },
  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!app.guard()) { this.setData({ loading: false }); return; }
    try {
      const res = await api.get('/api/addresses');
      this.setData({ list: res.list || [], loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  openAdd() {
    this.setData({
      showEdit: true,
      editing: null,
      form: { name: '', phone: '', campus: '广东科贸职业学院（清远校区）', detail: '', isDefault: this.data.list.length === 0 }
    });
  },

  openEdit(e) {
    const a = this.data.list.find((x) => x.id === Number(e.currentTarget.dataset.id));
    if (!a) return;
    this.setData({
      showEdit: true,
      editing: a.id,
      form: {
        name: a.name || '', phone: a.phone || '', campus: a.campus || '',
        detail: a.detail || '', isDefault: !!a.isDefault
      }
    });
  },

  closeEdit() { this.setData({ showEdit: false, editing: null }); },
  noop() { /* 阻止冒泡 */ },

  onForm(e) {
    const k = e.currentTarget.dataset.k;
    const form = Object.assign({}, this.data.form);
    form[k] = e.detail.value;
    this.setData({ form });
  },

  toggleDefault() {
    this.setData({ form: Object.assign({}, this.data.form, { isDefault: !this.data.form.isDefault }) });
  },

  async onSave() {
    const f = this.data.form;
    if (!f.name || !f.name.trim()) return wx.showToast({ title: '请填写联系人', icon: 'none' });
    if (!/^1\d{10}$/.test(String(f.phone || '').trim())) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' });
    if (!f.detail || !f.detail.trim()) return wx.showToast({ title: '请填写详细地址', icon: 'none' });
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      if (this.data.editing) {
        await api.patch('/api/addresses/' + this.data.editing, f, { loading: true });
      } else {
        await api.post('/api/addresses', f, { loading: true });
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showEdit: false, editing: null, saving: false });
      this.fetch();
    } catch (e) {
      this.setData({ saving: false });
    }
  },

  async onDelete(e) {
    const id = Number(e.currentTarget.dataset.id);
    wx.showModal({
      title: '删除地址', content: '确定删除这条地址吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.del('/api/addresses/' + id, {}, { loading: true });
          wx.showToast({ title: '已删除', icon: 'none' });
          this.fetch();
        } catch (err) { /* 已提示 */ }
      }
    });
  },

  async setDefault(e) {
    const id = Number(e.currentTarget.dataset.id);
    try {
      await api.patch('/api/addresses/' + id, { isDefault: true }, { silent: true });
      wx.showToast({ title: '已设为默认', icon: 'none' });
      this.fetch();
    } catch (err) { /* 已提示 */ }
  },

  copy(e) {
    const a = this.data.list.find((x) => x.id === Number(e.currentTarget.dataset.id));
    if (!a) return;
    wx.setClipboardData({
      data: a.name + ' ' + a.phone + ' ' + (a.campus || '') + (a.detail || ''),
      success: () => wx.showToast({ title: '地址已复制', icon: 'none' })
    });
  }
});
