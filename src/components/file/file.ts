// (C) Copyright 2015 Martin Dougiamas
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, Input, Output, OnInit, OnDestroy, EventEmitter } from '@angular/core';
import { CoreAppProvider } from '@providers/app';
import { CoreEventsProvider } from '@providers/events';
import { CoreFilepoolProvider } from '@providers/filepool';
import { CoreFileHelperProvider } from '@providers/file-helper';
import { CoreSitesProvider } from '@providers/sites';
import { CoreDomUtilsProvider } from '@providers/utils/dom';
import { CoreMimetypeUtilsProvider } from '@providers/utils/mimetype';
import { CoreUtilsProvider } from '@providers/utils/utils';
import { CoreConstants } from '@core/constants';

/**
 * Component to handle a remote file. Shows the file name, icon (depending on mimetype) and a button
 * to download/refresh it.
 */
@Component({
    selector: 'core-file',
    templateUrl: 'file.html'
})
export class CoreFileComponent implements OnInit, OnDestroy {
    @Input() file: any; // The file. Must have a property 'filename' and a 'fileurl' or 'url'
    @Input() component?: string; // Component the file belongs to.
    @Input() componentId?: string | number; // Component ID.
    @Input() canDelete?: boolean | string; // Whether file can be deleted.
    @Input() alwaysDownload?: boolean | string; // Whether it should always display the refresh button when the file is downloaded.
                                                // Use it for files that you cannot determine if they're outdated or not.
    @Input() canDownload?: boolean | string = true; // Whether file can be downloaded.
    @Output() onDelete?: EventEmitter<string>; // Will notify when the delete button is clicked.

    isDownloaded: boolean;
    isDownloading: boolean;
    showDownload: boolean;
    fileIcon: string;
    fileName: string;

    protected fileUrl: string;
    protected siteId: string;
    protected fileSize: number;
    protected state: string;
    protected timemodified: number;
    protected observer;

    constructor(private sitesProvider: CoreSitesProvider, private utils: CoreUtilsProvider, private domUtils: CoreDomUtilsProvider,
            private filepoolProvider: CoreFilepoolProvider, private appProvider: CoreAppProvider,
            private fileHelper: CoreFileHelperProvider, private mimeUtils: CoreMimetypeUtilsProvider,
            private eventsProvider: CoreEventsProvider) {
        this.onDelete = new EventEmitter();
    }

    /**
     * Component being initialized.
     */
    ngOnInit(): void {
        this.canDelete = this.utils.isTrueOrOne(this.canDelete);
        this.alwaysDownload = this.utils.isTrueOrOne(this.alwaysDownload);
        this.canDownload = this.utils.isTrueOrOne(this.canDownload);

        this.fileUrl = this.fileHelper.getFileUrl(this.file);
        this.timemodified = this.fileHelper.getFileTimemodified(this.file);
        this.siteId = this.sitesProvider.getCurrentSiteId();
        this.fileSize = this.file.filesize;
        this.fileName = this.file.filename;

        if (this.file.isexternalfile) {
            this.alwaysDownload = true; // Always show the download button in external files.
        }

        this.fileIcon = this.mimeUtils.getFileIcon(this.file.filename);

        if (this.canDownload) {
            this.calculateState();

            // Update state when receiving events about this file.
            this.filepoolProvider.getFileEventNameByUrl(this.siteId, this.fileUrl).then((eventName) => {
                this.observer = this.eventsProvider.on(eventName, () => {
                    this.calculateState();
                });
            });
        }
    }

    /**
     * Convenience function to get the file state and set variables based on it.
     *
     * @return {Promise<void>} Promise resolved when state has been calculated.
     */
    protected calculateState(): Promise<void> {
        return this.filepoolProvider.getFileStateByUrl(this.siteId, this.fileUrl, this.timemodified).then((state) => {
            const canDownload = this.sitesProvider.getCurrentSite().canDownloadFiles();

            this.state = state;
            this.isDownloaded = state === CoreConstants.DOWNLOADED || state === CoreConstants.OUTDATED;
            this.isDownloading = canDownload && state === CoreConstants.DOWNLOADING;
            this.showDownload = canDownload && (state === CoreConstants.NOT_DOWNLOADED || state === CoreConstants.OUTDATED ||
                (this.alwaysDownload && state === CoreConstants.DOWNLOADED));
        });
    }

    /**
     * Convenience function to open a file, downloading it if needed.
     *
     * @return {Promise<string>} Promise resolved when file is opened.
     */
    protected openFile(): Promise<any> {
        return this.fileHelper.downloadAndOpenFile(this.file, this.component, this.componentId, this.state, (event) => {
            if (event && event.calculating) {
                // The process is calculating some data required for the download, show the spinner.
                this.isDownloading = true;
            }
        }).catch((error) => {
            this.domUtils.showErrorModalDefault(error, 'core.errordownloading', true);
        });
    }

    /**
     * Download a file and, optionally, open it afterwards.
     *
     * @param {Event} e Click event.
     * @param {boolean} openAfterDownload Whether the file should be opened after download.
     */
    download(e: Event, openAfterDownload: boolean): void {
        e.preventDefault();
        e.stopPropagation();

        let promise;

        if (this.isDownloading && !openAfterDownload) {
            return;
        }

        if (!this.appProvider.isOnline() && (!openAfterDownload || (openAfterDownload && !this.isDownloaded))) {
            this.domUtils.showErrorModal('core.networkerrormsg', true);

            return;
        }

        if (openAfterDownload) {
            // File needs to be opened now.
            this.openFile().catch((error) => {
                this.domUtils.showErrorModalDefault(error, 'core.errordownloading', true);
            });
        } else {
            // File doesn't need to be opened (it's a prefetch). Show confirm modal if file size is defined and it's big.
            promise = this.fileSize ? this.domUtils.confirmDownloadSize({ size: this.fileSize, total: true }) : Promise.resolve();
            promise.then(() => {
                // User confirmed, add the file to queue.
                this.filepoolProvider.invalidateFileByUrl(this.siteId, this.fileUrl).finally(() => {
                    this.isDownloading = true;
                    this.filepoolProvider.addToQueueByUrl(this.siteId, this.fileUrl, this.component,
                        this.componentId, this.timemodified, undefined, undefined, 0, this.file).catch((error) => {
                            this.domUtils.showErrorModalDefault(error, 'core.errordownloading', true);
                            this.calculateState();
                        });
                });
            });
        }
    }

    /**
     * Delete the file.
     *
     * @param {Event} e Click event.
     */
    deleteFile(e: Event): void {
        e.preventDefault();
        e.stopPropagation();

        if (this.canDelete) {
            this.onDelete.emit();
        }
    }

    /**
     * Component destroyed.
     */
    ngOnDestroy(): void {
        this.observer && this.observer.off();
    }
}