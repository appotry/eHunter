// a singleton service for caching img url
import { TextReq } from '../../base/request/TextReq'
import { ImgHtmlParser } from '../parser/ImgHtmlParser'
import { ImgUrlListParser } from '../parser/ImgUrlListParser'
import { IntroHtmlParser } from '../parser/IntroHtmlParser'
import * as API from '../api'
import storage from '../../../../core/service/storage/LocalStorage'
import Logger from '../../../../core/utils/Logger'
import InfoService from '../../../../core/service/InfoService'
import SettingService from '../../../../core/service/SettingService'
import store from '../../../../core/store'
import * as tags from '../../../../core/assets/value/tags'
import Utils from '../../../../core/utils/Utils'
import { AlbumServiceImpl } from './AlbumServiceImpl'
import { ThumbInfo } from '../../../../core/bean/ThumbInfo'
import { ImgPageInfo } from '../../../../core/bean/ImgPageInfo'

/*
storage
  |-key: (albumId: string); value: AlbumCache
 */
interface AlbumCache {
    title: string;
    thumbInfos: Array<ThumbInfo>;
    imgPageInfos: Array<ImgPageInfo>;
}

export class AlbumCacheService {
    private version = '2.2';
    private storageName = 'AlbumCache';
    private storageVersionName = 'AlbumCacheVersion';
    private _isNormalMode = false; // make sure in 'Normal' mode
    private _isChangedMode = false;
    private albumService: AlbumServiceImpl;
    private _album: AlbumCache | undefined;

    constructor(albumService) {
        this._initStorage();
        this._migrate();
        this.albumService = albumService;
    }

    async _migrate() {
        // remove version < 2.0
        // await Platform.storage.local.get('cache', async(value) => {
        //     if (typeof value['cache'] !== 'undefined') {
        //         await Platform.storage.local.remove('cache', () => {});
        //         await Platform.storage.local.remove('cacheVersion', () => {});
        //     }
        // });
        // remove old version >= 2.0
        let version = await storage.load({ key: this.storageVersionName });
        await storage.save({ key: this.storageVersionName, data: this.version });
        if (version !== this.version) {
            await storage.clearMapForKey(this.storageName);
            window.location.reload(); // TODO: need a notification
        }
    }

    _initStorage() {
        storage.sync[this.storageVersionName] = (params) => {
            let { resolve } = params;
            if (resolve) {
                return resolve(this.version);
            }
        };
    }

    async _getAlbum(albumId: string): Promise<AlbumCache> {
        if (this._album) {
            return this._album;
        } else {
            // disable cache to avoid cache problem
            // let now = new Date().getTime()
            // if (now < 1732757677943) { // before 2024-11-28, disable cache
                this._album = {
                    title: '',
                    thumbInfos: [],
                    imgPageInfos: []
                };
                return this._album!;
            // }
            // try {
            //     this._album = await storage.load({ key: this.storageName, id: albumId });
            // } catch (e) {
            //     this._album = {
            //         title: '',
            //         thumbInfos: [],
            //         imgPageInfos: []
            //     };
            // }
            // return this._album!;
        }
    }

    async _saveAlbum(albumId: string): Promise<void> {
        // L.o('save', this._album);
        await storage.save({ key: this.storageName, id: albumId, data: await this._getAlbum(albumId), expires: 1000 * 60 * 60 });
    }

    async getThumbInfos(albumId: string, introUrl, sumOfPage): Promise<Array<ThumbInfo>> {
        let imgPageInfos = await this.getImgPageInfos(albumId, introUrl, sumOfPage);
        let result = imgPageInfos.map((i: ImgPageInfo) => {
            return {
                id: i.id,
                src: '',
                mode: 0,
                offset: 0,
                style: i.thumbStyle,
                height: i.thumbHeight!,
                width: i.thumbWidth!,
            }
        })
        return result
    }

    async getImgPageInfos(albumId: string, introUrl: string, sumOfPage: number): Promise<Array<ImgPageInfo>> {
        let album = await this._getAlbum(albumId);
        if (album.imgPageInfos.length > 0) {
            Logger.logText('CacheService', 'read imgPageInfos from cache');
            return JSON.parse(JSON.stringify(album.imgPageInfos));
        } else {
            try {
                return await this._getImgPageInfos(albumId, introUrl, sumOfPage);
            } catch (e) {
                Logger.logText('CacheService', 'loading ImgPageInfos failed. error: ' + e);
                return []
            }
        }
    }

    async _getImgPageInfos(albumId: string, introUrl: string, sumOfPage: number): Promise<Array<ImgPageInfo>> {
        let album = await this._getAlbum(albumId);
        let imgPageInfos = await (new ImgUrlListParser(introUrl, sumOfPage)).request();
        this._album!.imgPageInfos = imgPageInfos;
        await this._saveAlbum(albumId);
        if (this._isChangedMode) {
            window.fetch(`${introUrl}?inline_set=ts_l`, { method: 'GET', credentials: 'include' }); // change back
        }
        return JSON.parse(JSON.stringify(album.imgPageInfos));
    }

    async getImgSrc(albumId, index, mode, sourceId?): Promise<ImgPageInfo | Error> {
        let album = await this._getAlbum(albumId);
        if (album.imgPageInfos[index].src) {
            return {...album.imgPageInfos[index]};
        }
        try {
            let param = sourceId ? `?nl=${sourceId}` : ''; // change source 0f img
            let req = new TextReq(album.imgPageInfos[index].pageUrl + param);
            if (mode === tags.MODE_FAST) { // fast fetch
                req.setTimeOutTime(3);
            }
            let text = await req.request();
            let parser = new ImgHtmlParser(text);
            switch (mode) {
                case tags.MODE_ORIGIN: // if want to load original img
                    try {
                        album.imgPageInfos[index].src = parser.getOriginalImgUrl();
                    } catch (e) {
                        return Error(tags.ERROR_NO_ORIGIN);
                    }
                    break;
                case tags.MODE_CHANGE_SOURCE:
                    if (!sourceId) {
                        return await this.getImgSrc(albumId, index, null, parser.getSourceId());
                    }
                    break;
                default:
                    album.imgPageInfos[index].src = parser.getImgUrl();
            }
            album.imgPageInfos[index].preciseHeightOfWidth = parser.getPreciseHeightOfWidth();
            await this._saveAlbum(albumId);
            return {...album.imgPageInfos[index]};
        } catch (e) {
            console.error(e);
            return new Error(tags.STATE_ERROR);
            // TODO: show tips for the error
        }
    }

    async getNewImgSrc(albumId: string, index: number, mode): Promise<ImgPageInfo | Error> {
        let album = await this._getAlbum(albumId);
        album.imgPageInfos[index].src = '';
        await this._saveAlbum(albumId);
        return await this.getImgSrc(albumId, index, mode);
    }
}
