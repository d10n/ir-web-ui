import { z } from 'zod';
import { osimRuntime } from '@/stores/osimRuntime';
import { useUserStore } from '../stores/UserStore';
import { useSettingsStore } from '@/stores/SettingsStore';
import { useToastStore } from '@/stores/ToastStore';

const RefreshResponse = z.object({
  access: z.string(),
});


type OsidbFetchCallbacks = {
  beforeFetch?: (args: {url: string, options?: OsidbFetchOptions}) => Promise<void> | void;
  // afterFetch?: (response: Response) => Promise<void> | void;
};

type OsidbFetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'get' | 'post' | 'put' | 'delete'; // | 'PATCH' | 'OPTIONS' | 'HEAD',
  data?: Record<string, any>;
  params?: Record<string, any>;
  url: string;
};

export async function osidbFetch(config: OsidbFetchOptions, factoryOptions?: OsidbFetchCallbacks) {

  if (factoryOptions?.beforeFetch) {
    await factoryOptions.beforeFetch(config);
  }

  const body = config?.data ? JSON.stringify(config.data) : undefined;
  const queryString = queryStringFromParams(config?.params ?? {});
  const baseUrl = osimRuntime.value.backends.osidb;

  if (config?.method?.toUpperCase() !== 'GET' && osimRuntime.value.readOnly) {
    useToastStore().addToast({ title: 'Operation Not Permitted', body: 'OSIM is in read-only mode.' });
    return Promise.reject('OSIM is in read-only mode.');
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${config.url}${queryString}`, {
      method: config?.method ?? 'GET',
      headers: await osimRequestHeaders(),
      mode: 'cors',
      credentials: 'include',
      body,
    });
  } catch (e) {
    return Promise.reject(e);
  }

  if (!response.ok) {
    let data;
    if (response.headers.get('content-type')?.startsWith('text/html')) {
      data = await response.text();
    } else {
      data = await response.json();
    }

    return Promise.reject({ 
      response: {
        headers: Object.fromEntries(response.headers.entries()),
        ok: response.ok,
        redirected: response.redirected,
        status: response.status,
        statusText: response.statusText,
        type: response.type,
        url: response.url,
        data,
      },
      data,
    }, 
    );
  }

  return { data: await response.json(), response };
}

async function osimRequestHeaders() {
  const settingsStore = useSettingsStore();
  const token = await getNextAccessToken();
  return new Headers({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Bugzilla-Api-Key': settingsStore.settings.bugzillaApiKey,
    'Jira-Api-Key': settingsStore.settings.jiraApiKey,
  });
}

function paramsFrom(params: Record<string, any>) {
  const urlParams = new URLSearchParams();
  for (const key in params) {
    if (params[key] !== undefined) {
      urlParams.set(key, params[key]);
    }
  }
  return urlParams;
}

function queryStringFromParams(params: Record<string, any>) {
  const urlParams = paramsFrom(params);
  const queryString = urlParams.toString();
  return queryString ? `?${queryString}` : '';
}

export async function getNextAccessToken() {
  // Moving this to module scope results in "cannot access before initialization" -
  // probably a vite or typescript bug
  const url = `${osimRuntime.value.backends.osidb}/auth/token/refresh`;
  const userStore = useUserStore();
  let response;
  try {
    const fetchResponse = await fetch(url, {
      method: 'post',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        refresh: userStore.refresh,
      }),
    });
    response = await fetchResponse.json();
  } catch (e) {
    return userStore.logout()
      .finally(() => {
        throw new Error('Refresh token expired');
      });
  }
  try {
    const responseBody = response;
    const parsedBody = RefreshResponse.parse(responseBody);
    return parsedBody.access;
  } catch (e) {
    console.log('error', e);
    return userStore.logout()
      .finally(() => {
        throw new Error('Unable to parse next access token');
      });
  }
}

function parseOsidbErrorsJson(data: Record<string, any>) { 
  return Object.entries(data)
    .filter(([key]) => !['dt','env','revision','version'].includes(key))
    .map(([key, value]) => `${key}: ${value}`);
}

export function getDisplayedOsidbError(error: any) {
  if (error.response) {
    if (error.response.headers?.['content-type']?.startsWith('text/html')) {
      // server in debug mode?
      const parser = new DOMParser();
      const doc = parser.parseFromString(
        error.response.data, error.response.headers['content-type']
      );
      const exception_value = doc.querySelector('.exception_value');
      const text = (exception_value as HTMLElement)?.innerText;

      return 'Likely error between OSIDB and database:\n' + text;
    } else {
      const { status, statusText } = error.response;
      return `OSIDB responded with error ${status} (${statusText}). \n` +
      `${
        error.response.data instanceof Object ?
          // JSON.stringify(error.response.data, null, 2) :
          parseOsidbErrorsJson(error.response.data):
          error.response.data
      }`;
    }
  } else if (error.request) {
    return error.request.toString(); // XMLHttpRequest object
  }
  return error.toString();
}
