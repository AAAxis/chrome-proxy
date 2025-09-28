// Proxy Router Extension - SOCKS5 Client Only
class SOCKS5ProxyService {
  constructor() {
    this.isInitialized = false;
    this.clientId = null;
    this.isConnected = false;
    this.apiBaseUrl = 'https://api.theholylabs.com';
    this.proxyConfig = {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: "socks5",
          host: "69.197.134.25",
          port: 3128
        }
      }
    };
  }

  async initialize() {
    try {
      // Load existing client ID from storage or create a new one
      const stored = await chrome.storage.local.get(['clientId']);
      if (stored.clientId) {
        this.clientId = stored.clientId;
        console.log('Using existing client ID:', this.clientId);
      } else {
        // Generate more unique client ID with better entropy
        const timestamp = Date.now();
        const randomPart = Math.random().toString(36).substr(2, 9);
        const sessionId = Math.random().toString(36).substr(2, 6);
        this.clientId = `chrome-${randomPart}-${sessionId}-${timestamp}`;
        await chrome.storage.local.set({ clientId: this.clientId });
        console.log('Created new client ID:', this.clientId);
      }
      
      this.isInitialized = true;
      console.log('SOCKS5 Proxy service initialized');
      return true;
    } catch (error) {
      console.error('Failed to initialize SOCKS5 service:', error);
      return false;
    }
  }

  async testAPIConnection() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/health`);
      if (!response.ok) {
        throw new Error(`API health check failed: ${response.status}`);
      }
      const data = await response.json();
      console.log('API health check passed:', data);
      return data;
    } catch (error) {
      console.error('API health check failed:', error);
      throw new Error(`API health check failed: ${error.message}`);
    }
  }

  async connect() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Register client with API (optional - don't fail if API is down)
      try {
        await this.registerClient();
      } catch (error) {
        console.warn('Failed to register with API, but continuing:', error.message);
      }

      // Set Chrome proxy configuration
      await chrome.proxy.settings.set({
        value: this.proxyConfig,
        scope: 'regular'
      });

      this.isConnected = true;
      await chrome.storage.local.set({
        isConnected: true,
        clientId: this.clientId
      });

      console.log('SOCKS5 proxy connected');
      return { success: true };
    } catch (error) {
      console.error('Failed to connect SOCKS5 proxy:', error);
      return { success: false, error: error.message };
    }
  }

  async disconnect() {
    try {
      // Clear proxy settings
      await chrome.proxy.settings.clear({
        scope: 'regular'
      });

      // Update client status
      if (this.clientId) {
        await this.updateClientStatus(false);
      }

      this.isConnected = false;
      await chrome.storage.local.set({
        isConnected: false
      });

      console.log('SOCKS5 proxy disconnected');
      return { success: true };
    } catch (error) {
      console.error('Failed to disconnect SOCKS5 proxy:', error);
      return { success: false, error: error.message };
    }
  }

  async registerClient() {
    try {
      // Generate unique device fingerprint
      const deviceFingerprint = await this.generateDeviceFingerprint();
      
      const clientData = {
        client_id: this.clientId,
        device_type: 'desktop',
        proxy_type: 'socks5',
        country: 'unknown',
        online: true,
        platform: 'Chrome Extension',
        user_agent: navigator.userAgent,
        is_chrome_extension: true,
        capabilities: ['socks5_proxy'],
        registration_time: Date.now(),
        is_proxy_enabled: true,
        device_fingerprint: deviceFingerprint,
        extension_version: chrome.runtime.getManifest().version,
        unique_identifier: `${this.clientId}-${deviceFingerprint}`
      };

      const response = await fetch(`${this.apiBaseUrl}/api/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(clientData)
      });

      if (!response.ok) {
        throw new Error(`Client registration failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('Client registered successfully:', result);
      return result;
    } catch (error) {
      console.error('Failed to register client:', error);
      throw error;
    }
  }

  async updateClientStatus(isEnabled) {
    try {
      const statusData = {
        online: true,
        proxy_type: 'socks5',
        is_proxy_enabled: isEnabled
      };

      const response = await fetch(`${this.apiBaseUrl}/api/clients/${this.clientId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(statusData)
      });

      if (!response.ok) {
        throw new Error(`Status update failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('Client status updated:', result);
      return result;
    } catch (error) {
      console.error('Failed to update client status:', error);
      throw error;
    }
  }

  async generateDeviceFingerprint() {
    try {
      // Create a unique device fingerprint based on available browser properties in service worker
      const fingerprint = {
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: Date.now(),
        // Add some randomness since screen properties aren't available in service worker
        randomSeed: Math.random().toString(36).substr(2, 9)
      };
      
      // Create a hash-like identifier from the fingerprint
      const fingerprintString = JSON.stringify(fingerprint);
      let hash = 0;
      for (let i = 0; i < fingerprintString.length; i++) {
        const char = fingerprintString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      
      return Math.abs(hash).toString(36);
    } catch (error) {
      console.error('Error generating device fingerprint:', error);
      return Math.random().toString(36).substr(2, 9);
    }
  }

  async getStatus() {
    try {
      const result = await chrome.storage.local.get(['isConnected', 'clientId']);
      return {
        success: true,
        isConnected: result.isConnected || false,
        clientId: result.clientId || this.clientId
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

class ProxyRouterExtension {
  constructor() {
    this.socks5Service = new SOCKS5ProxyService();
    this.isConnected = false;
    this.clientId = null;
  }

  async init() {
    console.log('Proxy Router Extension initialized');
    await this.socks5Service.initialize();
    this.setupEventListeners();
    await this.loadState();
    console.log('Extension ready');
  }

  async loadState() {
    try {
      const result = await chrome.storage.local.get(['isConnected', 'clientId']);
      this.isConnected = result.isConnected || false;
      this.clientId = result.clientId || this.socks5Service.clientId;
    } catch (error) {
      console.error('Failed to load state:', error);
    }
  }

  setupEventListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });
  }

  async handleMessage(message, sender, sendResponse) {
    try {
      switch (message.action) {
        case 'getSettings':
          const status = await this.socks5Service.getStatus();
          sendResponse({
            success: true,
            settings: {
              isProxyEnabled: status.isConnected,
              clientId: status.clientId
            }
          });
          break;

        case 'toggleProxy':
          if (message.enabled) {
            const result = await this.socks5Service.connect();
            if (result.success) {
              this.isConnected = true;
              this.clientId = this.socks5Service.clientId;
            }
            sendResponse(result);
          } else {
            const result = await this.socks5Service.disconnect();
            if (result.success) {
              this.isConnected = false;
            }
            sendResponse(result);
          }
          break;

        case 'updateSettings':
          await chrome.storage.local.set({
            isConnected: message.settings.isProxyEnabled || false,
            clientId: message.settings.clientId || this.clientId
          });
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  }
}

let proxyRouter = null;

function initializeExtension() {
  if (!proxyRouter) {
    console.log('Initializing Proxy Router Extension');
    proxyRouter = new ProxyRouterExtension();
    proxyRouter.init();
  }
}

chrome.runtime.onStartup.addListener(() => {
  initializeExtension();
});

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

initializeExtension();
