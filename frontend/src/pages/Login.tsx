import { useEffect, useState } from 'react';
import './Login.css';
import {
  CheckOssutilInstalled,
  GetDefaultProfile,
  GetOssutilPath,
  GetSettings,
  LoadProfiles,
  SaveProfile,
  SaveSettings,
  SetOssutilPath,
  TestConnection,
} from '../../wailsjs/go/main/OSSService';
import { main } from '../../wailsjs/go/models';
import ProfilePicker from '../components/ProfilePicker';

interface LoginProps {
  onLoginSuccess: (config: main.OSSConfig, profileName?: string | null) => void;
}

type InlineMessage = { type: 'success' | 'error' | 'info'; text: string };

function Login({ onLoginSuccess }: LoginProps) {
  const [accessKeyId, setAccessKeyId] = useState('');
  const [accessKeySecret, setAccessKeySecret] = useState('');
  const [region, setRegion] = useState('cn-hangzhou');
  const [endpoint, setEndpoint] = useState('');
  const [defaultPath, setDefaultPath] = useState('');

  const [profiles, setProfiles] = useState<main.OSSProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');

  const [saveAsProfile, setSaveAsProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);

  const [driverOssutilPath, setDriverOssutilPath] = useState('');
  const [driverWorkDir, setDriverWorkDir] = useState('~/.walioss');
  const [driverStatus, setDriverStatus] = useState<InlineMessage | null>(null);
  const [driverTesting, setDriverTesting] = useState(false);
  const [driverSaving, setDriverSaving] = useState(false);

  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [message, setMessage] = useState<InlineMessage | null>(null);

  useEffect(() => {
    void initializeApp();
  }, []);

  const renderDriverStatus = (result: main.ConnectionResult): InlineMessage => {
    if (!result.success) {
      return {
        type: 'error',
        text: result.message || 'ossutil is not available',
      };
    }
    const versionLine =
      (result.message || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => !!line) || result.message || 'Detected';
    return {
      type: 'success',
      text: `ossutil version: ${versionLine}`,
    };
  };

  const loadProfilesAndDefault = async () => {
    const savedProfiles = await LoadProfiles();
    setProfiles(savedProfiles || []);

    const defaultProfile = await GetDefaultProfile();
    if (defaultProfile) {
      loadProfile(defaultProfile);
      setSelectedProfile(defaultProfile.name);
      return;
    }

    if (selectedProfile && !(savedProfiles || []).some((p) => p.name === selectedProfile)) {
      setSelectedProfile('');
    }
  };

  const initializeApp = async () => {
    try {
      const settings = await GetSettings();
      setDriverOssutilPath(settings?.ossutilPath || '');
      setDriverWorkDir(settings?.workDir || '~/.walioss');

      if (settings?.defaultRegion) {
        setRegion(settings.defaultRegion);
      }
      if (settings?.defaultEndpoint) {
        setEndpoint(settings.defaultEndpoint);
      }

      const result = await CheckOssutilInstalled();
      setDriverStatus(renderDriverStatus(result));
    } catch (error: any) {
      setDriverStatus({ type: 'error', text: error?.message || 'Failed to load driver configuration' });
    }

    try {
      await loadProfilesAndDefault();
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const loadProfile = (profile: main.OSSProfile) => {
    setAccessKeyId(profile.config.accessKeyId);
    setAccessKeySecret(profile.config.accessKeySecret);
    setRegion(profile.config.region);
    setEndpoint(profile.config.endpoint || '');
    setDefaultPath(profile.config.defaultPath || '');
  };

  const handleProfileChange = (nextProfileName: string) => {
    setSelectedProfile(nextProfileName);
    const profile = profiles.find((p) => p.name === nextProfileName);
    if (profile) {
      loadProfile(profile);
      return;
    }

    setAccessKeyId('');
    setAccessKeySecret('');
    setRegion('cn-hangzhou');
    setEndpoint('');
    setDefaultPath('');
  };

  const handleTestDriver = async () => {
    setDriverTesting(true);
    try {
      const original = await GetOssutilPath();
      try {
        await SetOssutilPath(driverOssutilPath);
        const result = await CheckOssutilInstalled();
        setDriverStatus(renderDriverStatus(result));
      } finally {
        await SetOssutilPath(original);
      }
    } catch (error: any) {
      setDriverStatus({ type: 'error', text: error?.message || 'Driver test failed' });
    } finally {
      setDriverTesting(false);
    }
  };

  const handleApplyDriverConfig = async () => {
    setDriverSaving(true);
    try {
      const current = await GetSettings();
      const resolvedWorkDir = driverWorkDir.trim() || '~/.walioss';
      const nextSettings: main.AppSettings = {
        ...current,
        ossutilPath: driverOssutilPath,
        workDir: resolvedWorkDir,
      };
      await SaveSettings(nextSettings);

      const saved = await GetSettings();
      setDriverOssutilPath(saved?.ossutilPath || '');
      setDriverWorkDir(saved?.workDir || '~/.walioss');

      const result = await CheckOssutilInstalled();
      setDriverStatus(renderDriverStatus(result));

      await loadProfilesAndDefault();
      setMessage({ type: 'success', text: 'Driver configuration updated' });
    } catch (error: any) {
      const text = error?.message || 'Failed to save driver configuration';
      setDriverStatus({ type: 'error', text });
      setMessage({ type: 'error', text });
    } finally {
      setDriverSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!accessKeyId || !accessKeySecret || !region) {
      setMessage({ type: 'error', text: 'Please fill in required fields' });
      return;
    }

    setTestingConnection(true);
    setMessage(null);

    try {
      const config: main.OSSConfig = {
        accessKeyId,
        accessKeySecret,
        region,
        endpoint,
        defaultPath,
      };

      const result = await TestConnection(config);
      if (result.success) {
        setMessage({ type: 'success', text: 'Connection successful!' });
      } else {
        setMessage({ type: 'error', text: result.message });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Connection test failed' });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleConnect = async () => {
    if (!accessKeyId || !accessKeySecret || !region) {
      setMessage({ type: 'error', text: 'Please fill in required fields' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const config: main.OSSConfig = {
        accessKeyId,
        accessKeySecret,
        region,
        endpoint,
        defaultPath,
      };

      const result = await TestConnection(config);
      if (!result.success) {
        setMessage({ type: 'error', text: result.message });
        setLoading(false);
        return;
      }

      if (saveAsProfile && profileName) {
        const profile = new main.OSSProfile({
          name: profileName,
          config,
          isDefault: setAsDefault,
        });
        await SaveProfile(profile);
        const savedProfiles = await LoadProfiles();
        setProfiles(savedProfiles || []);
      }

      const resolvedProfileName = selectedProfile || (saveAsProfile ? profileName.trim() : '') || null;
      onLoginSuccess(config, resolvedProfileName);
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Connection failed' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-shell">
        <div className="login-side">
          <div className="login-side-brand">
            <img className="login-side-icon" src="/appicon.png" alt="Walioss" />
            <div className="login-side-brand-text">
              <div className="login-side-title">Walioss</div>
              <div className="login-side-subtitle">Profiles</div>
            </div>
          </div>

          <div className="login-side-section">
            <div className="login-side-section-title">Profile</div>
            {profiles.length > 0 ? (
              <ProfilePicker profiles={profiles} value={selectedProfile} onChange={handleProfileChange} />
            ) : (
              <div className="form-hint">No saved profiles yet.</div>
            )}
          </div>

          <div className="login-side-section">
            <div className="login-side-section-title">Driver Configuration</div>
            <div className="driver-form">
              <div className="form-group">
                <label className="form-label">ossutil Path</label>
                <input
                  type="text"
                  className="form-input"
                  value={driverOssutilPath}
                  onChange={(e) => setDriverOssutilPath(e.target.value)}
                  placeholder="Leave empty to auto-detect in system PATH"
                />
                <div className="form-hint">Leave empty to auto-detect ossutil from system PATH or bundled binary.</div>
              </div>

              <div className="form-group">
                <label className="form-label">Walioss Work Directory</label>
                <input
                  type="text"
                  className="form-input"
                  value={driverWorkDir}
                  onChange={(e) => setDriverWorkDir(e.target.value)}
                  placeholder="~/.walioss"
                />
                <div className="form-hint">Stores app config and profiles in JSON format.</div>
              </div>

              {driverStatus && (
                <div className={`message ${driverStatus.type} driver-message`}>
                  <span className="message-icon">
                    {driverStatus.type === 'success' && '✓'}
                    {driverStatus.type === 'error' && '✕'}
                    {driverStatus.type === 'info' && 'ℹ'}
                  </span>
                  <span>{driverStatus.text}</span>
                </div>
              )}

              <div className="driver-actions">
                <button className="btn btn-secondary" type="button" onClick={handleTestDriver} disabled={driverTesting || driverSaving}>
                  {driverTesting ? (
                    <>
                      <span className="spinner"></span>
                      Testing...
                    </>
                  ) : (
                    'Test Driver'
                  )}
                </button>
                <button className="btn btn-secondary" type="button" onClick={handleApplyDriverConfig} disabled={driverSaving || driverTesting}>
                  {driverSaving ? (
                    <>
                      <span className="spinner"></span>
                      Applying...
                    </>
                  ) : (
                    'Apply'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="login-card">
          <div className="login-header">
            <h1 className="login-title">Walioss</h1>
            <p className="login-subtitle">Connect to Alibaba Cloud OSS</p>
          </div>

          <div className="login-form">
            <div className="form-group">
              <label className="form-label">AccessKey ID *</label>
              <input
                type="text"
                className="form-input"
                placeholder="Enter your AccessKey ID"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="form-group">
              <label className="form-label">AccessKey Secret *</label>
              <input
                type="password"
                className="form-input"
                placeholder="Enter your AccessKey Secret"
                value={accessKeySecret}
                onChange={(e) => setAccessKeySecret(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Region *</label>
                <input type="text" className="form-input" placeholder="e.g. cn-hangzhou" value={region} onChange={(e) => setRegion(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Endpoint</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Custom endpoint (optional)"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
                {endpoint.toLowerCase().includes('oss-accesspoint') && (
                  <div className="form-hint" style={{ marginTop: '6px', opacity: 0.85, fontSize: '12px' }}>
                    Tip: Access Point endpoints (…oss-accesspoint…) are bucket-scoped and cannot list buckets. Leave Endpoint empty or use a
                    service endpoint like <code>oss-cn-hangzhou.aliyuncs.com</code>.
                  </div>
                )}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Default Path</label>
              <input
                type="text"
                className="form-input"
                placeholder="oss://bucket/prefix/ (optional)"
                value={defaultPath}
                onChange={(e) => setDefaultPath(e.target.value)}
              />
              <div className="form-hint" style={{ marginTop: '6px', opacity: 0.7, fontSize: '12px' }}>
                For accounts without list-all-buckets permission, enter a path like <code>oss://bucket/folder/</code> to open directly after
                login.
              </div>
            </div>

            <div className="form-group">
              <div className="save-profile-section">
                <label>
                  <input type="checkbox" checked={saveAsProfile} onChange={(e) => setSaveAsProfile(e.target.checked)} />
                  Save as profile
                </label>
                {saveAsProfile && (
                  <>
                    <input type="text" className="form-input" placeholder="Profile name" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                    <label>
                      <input type="checkbox" checked={setAsDefault} onChange={(e) => setSetAsDefault(e.target.checked)} />
                      Default
                    </label>
                  </>
                )}
              </div>
            </div>

            <div className="button-group">
              <button className="btn btn-secondary" onClick={handleTestConnection} disabled={testingConnection || loading}>
                {testingConnection ? (
                  <>
                    <span className="spinner"></span>
                    Testing...
                  </>
                ) : (
                  'Test Connection'
                )}
              </button>
              <button className="btn btn-primary" onClick={handleConnect} disabled={loading || testingConnection}>
                {loading ? (
                  <>
                    <span className="spinner"></span>
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>

            {message && (
              <div className={`message ${message.type}`}>
                <span className="message-icon">
                  {message.type === 'success' && '✓'}
                  {message.type === 'error' && '✕'}
                  {message.type === 'info' && 'ℹ'}
                </span>
                <span>{message.text}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
