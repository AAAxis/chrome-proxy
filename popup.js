// Proxy Router Extension - SOCKS5 Client Only
class SimplePopupController {
  constructor() {
    this.elements = {};
    this.isConnected = false;
    this.isLoading = false;
    this.privacyAccepted = false;
    
    this.init();
  }

  init() {
    this.cacheElements();
    this.bindEvents();
    this.loadInitialData();
  }

  cacheElements() {
    this.elements = {
      statusText: document.getElementById('statusText'),
      currentIP: document.getElementById('currentIP'),
      ipLabel: document.getElementById('ipLabel'),
      ipRow: document.getElementById('ipRow'),
      socks5Switch: document.getElementById('socks5Switch'),
      socks5Status: document.getElementById('socks5Status'),
      socks5Indicator: document.getElementById('socks5Indicator'),
      socks5StatusText: document.getElementById('socks5StatusText'),
      socks5HelpText: document.getElementById('socks5HelpText'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      errorMessage: document.getElementById('errorMessage'),
      errorText: document.getElementById('errorText'),
      closeError: document.getElementById('closeError'),
      privacyPage: document.getElementById('privacyPage'),
      acceptPrivacy: document.getElementById('acceptPrivacy'),
      mainContent: document.querySelector('.main-content'),
      container: document.querySelector('.container')
    };
    
    console.log('Cached elements:', this.elements);
  }

  bindEvents() {
    // SOCKS5 switch
    if (this.elements.socks5Switch) {
      this.elements.socks5Switch.addEventListener('change', () => {
        this.toggleSOCKS5Connection();
      });
    }

    // Error close
    if (this.elements.closeError) {
      this.elements.closeError.addEventListener('click', () => {
        this.hideError();
      });
    }

    // Privacy policy buttons
    if (this.elements.acceptPrivacy) {
      this.elements.acceptPrivacy.addEventListener('click', () => {
        this.acceptPrivacyPolicy();
      });
    }

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message);
    });
  }

  async loadInitialData() {
    try {
      console.log('Loading initial data...');
      
      // Check if privacy policy has been accepted
      const privacyAccepted = await this.checkPrivacyAccepted();
      
      if (!privacyAccepted) {
        this.showPrivacyPage();
        return;
      }
      
      this.privacyAccepted = true;
      
      // Load settings
      await this.loadSettings();
      
      // Update UI based on loaded settings
      this.updateConnectionStatus();
      
      // Try to get current IP (works offline with fallback)
      await this.getCurrentIP();
      
    } catch (error) {
      console.error('Error loading initial data:', error);
      // Don't show error, just use defaults
      this.updateConnectionStatus();
    }
  }

  async loadSettings() {
    try {
      console.log('Loading settings from storage...');
      const result = await chrome.storage.local.get(['isConnected']);
      
      // Load settings with defaults
      this.isConnected = result.isConnected || false;
      
      console.log('Loaded settings:', {
        isConnected: this.isConnected
      });
      
      // Update switch based on loaded settings
      if (this.elements.socks5Switch) {
        this.elements.socks5Switch.checked = this.isConnected;
        console.log('Set SOCKS5 switch to:', this.elements.socks5Switch.checked);
      }
      
    } catch (error) {
      console.error('Error loading settings:', error);
      // Use defaults if loading fails
      this.isConnected = false;
    }
  }

  async saveSettings() {
    try {
      console.log('Saving settings:', {
        isConnected: this.isConnected
      });
      
      await chrome.storage.local.set({
        isConnected: this.isConnected
      });
      
      console.log('Settings saved successfully');
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  async toggleSOCKS5Connection() {
    if (this.isLoading) return;
    
    const newSOCKS5 = this.elements.socks5Switch.checked;
    console.log('Toggling SOCKS5 to:', newSOCKS5);
    
    this.isLoading = true;
    this.showLoading();
    
    try {
      // Send message to background script to toggle proxy
      const result = await this.sendMessage({
        action: 'toggleProxy',
        enabled: newSOCKS5
      });
      
      if (result.success) {
        this.isConnected = newSOCKS5;
        await this.saveSettings();
        this.updateConnectionStatus();
        
        if (newSOCKS5) {
          await this.getCurrentIP();
        } else {
          // When disconnected, get the original IP
          await this.getCurrentIP();
        }
      } else {
        throw new Error(result.error || 'Failed to toggle proxy');
      }
      
    } catch (error) {
      console.error('Error toggling SOCKS5 connection:', error);
      this.elements.socks5Switch.checked = !this.elements.socks5Switch.checked;
      this.showError('Failed to toggle connection: ' + error.message);
    } finally {
      this.isLoading = false;
      this.hideLoading();
    }
  }

  updateConnectionStatus() {
    console.log('Updating connection status, connected:', this.isConnected);
    
    // Update status text
    if (this.elements.statusText) {
      this.elements.statusText.textContent = this.isConnected ? 'Connected' : 'Disconnected';
      this.elements.statusText.className = this.isConnected ? 'value connected' : 'value disconnected';
    }
    
    // Update SOCKS5 status indicator
    if (this.elements.socks5Indicator) {
      this.elements.socks5Indicator.className = this.isConnected ? 'status-indicator connected' : 'status-indicator';
    }
    
    if (this.elements.socks5StatusText) {
      this.elements.socks5StatusText.textContent = this.isConnected ? 'Connected' : 'Disconnected';
    }
    
    if (this.elements.socks5HelpText) {
      this.elements.socks5HelpText.textContent = this.isConnected 
        ? 'Connected to SOCKS5 proxy server' 
        : 'Connect to SOCKS5 proxy server';
    }
  }

  async getCurrentIP() {
    try {
      // Try backend network-info endpoint first
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/network-info`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.network_info) {
            const networkInfo = data.network_info;
            const ip = networkInfo.public_ip || networkInfo.client_ip;
            const country = networkInfo.country;
            
            if (this.elements.currentIP) {
              this.elements.currentIP.textContent = ip || 'Unknown';
            }
            
            // Update country if we have that element
            if (country && country !== 'Unknown') {
              console.log(`Detected country: ${country}`);
            }
            
            return; // Success, exit
          }
        }
      } catch (error) {
        console.log('Backend network-info failed, trying fallback services:', error);
      }
      
      // Fallback to external IP services
      const ipServices = [
        'https://api.ipify.org?format=json',
        'https://ipapi.co/json/',
        'https://api.myip.com',
        'https://httpbin.org/ip'
      ];
      
      for (const service of ipServices) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(service, { 
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Chrome Extension)'
            }
          });
          
          clearTimeout(timeoutId);
          
          if (response.ok) {
            const data = await response.json();
            const ip = data.ip || data.query || data.origin;
            
            if (ip && this.elements.currentIP) {
              this.elements.currentIP.textContent = ip;
              console.log(`IP detected from ${service}: ${ip}`);
              return; // Success, exit
            }
          }
        } catch (error) {
          console.log(`Failed to get IP from ${service}:`, error.message);
          continue; // Try next service
        }
      }
      
      // If all services fail, show offline message
      if (this.elements.currentIP) {
        this.elements.currentIP.textContent = 'Offline';
      }
      
    } catch (error) {
      console.error('Error getting current IP:', error);
      if (this.elements.currentIP) {
        this.elements.currentIP.textContent = 'Error';
      }
    }
  }

  async sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });
  }

  handleMessage(message) {
    switch (message.action) {
      case 'connectionStatusChanged':
        this.isConnected = message.connected;
        this.elements.socks5Switch.checked = message.connected;
        this.updateConnectionStatus();
        break;
      case 'ipChanged':
        if (this.elements.currentIP) {
          this.elements.currentIP.textContent = message.ip;
        }
        break;
    }
  }

  showLoading() {
    if (this.elements.loadingOverlay) {
      this.elements.loadingOverlay.style.display = 'flex';
    }
  }

  hideLoading() {
    if (this.elements.loadingOverlay) {
      this.elements.loadingOverlay.style.display = 'none';
    }
  }

  showError(message) {
    if (this.elements.errorMessage && this.elements.errorText) {
      this.elements.errorText.textContent = message;
      this.elements.errorMessage.style.display = 'flex';
    }
  }

  hideError() {
    if (this.elements.errorMessage) {
      this.elements.errorMessage.style.display = 'none';
    }
  }

  async checkPrivacyAccepted() {
    try {
      const result = await chrome.storage.local.get(['privacyAccepted']);
      return result.privacyAccepted || false;
    } catch (error) {
      console.error('Error checking privacy acceptance:', error);
      return false;
    }
  }

  showPrivacyPage() {
    if (this.elements.privacyPage) {
      this.elements.privacyPage.style.display = 'block';
    }
    if (this.elements.mainContent) {
      this.elements.mainContent.style.display = 'none';
    }
  }

  async acceptPrivacyPolicy() {
    try {
      await chrome.storage.local.set({ privacyAccepted: true });
      this.privacyAccepted = true;
      
      if (this.elements.privacyPage) {
        this.elements.privacyPage.style.display = 'none';
      }
      if (this.elements.mainContent) {
        this.elements.mainContent.style.display = 'block';
      }
      
      // Reload data after accepting privacy policy
      await this.loadInitialData();
    } catch (error) {
      console.error('Error accepting privacy policy:', error);
    }
  }
}

// Initialize the popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing popup controller');
  new SimplePopupController();
});