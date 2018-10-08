/*
 * This file is part of the Dash-To-Panel extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Credits:
 * This file is based on code from the Dash to Dock extension by micheleg
 * and code from the Taskbar extension by Zorin OS
 * 
 * Code to re-anchor the panel was taken from Thoma5 BottomPanel:
 * https://github.com/Thoma5/gnome-shell-extension-bottompanel
 * 
 * Pattern for moving clock based on Frippery Move Clock by R M Yorston
 * http://frippery.org/extensions/
 * 
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const Utils = Me.imports.utils;
const Taskbar = Me.imports.taskbar;
const PanelStyle = Me.imports.panelStyle;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const CtrlAltTab = imports.ui.ctrlAltTab;
const Panel = imports.ui.panel;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const DND = imports.ui.dnd;
const Shell = imports.gi.Shell;
const PopupMenu = imports.ui.popupMenu;
const IconGrid = imports.ui.iconGrid;
const ViewSelector = imports.ui.viewSelector;
const DateMenu = imports.ui.dateMenu;

const Intellihide = Me.imports.intellihide;

let tracker = Shell.WindowTracker.get_default();

var dtpPanelWrapper = new Lang.Class({
    Name: 'DashToPanel.PanelWrapper',

    _init: function(panelManager, monitor, panel, panelBox, isSecondary) {
        this.panelManager = panelManager;
        this._dtpSettings = panelManager._dtpSettings;
        this.panelStyle = new PanelStyle.dtpPanelStyle(panelManager._dtpSettings);

        this.monitor = monitor;
        this.panel = panel;
        this.panelBox = panelBox;
        this.isSecondary = isSecondary;
    },

    enable : function() {
        let taskbarPosition = this._dtpSettings.get_string('taskbar-position');
        if (taskbarPosition == 'CENTEREDCONTENT' || taskbarPosition == 'CENTEREDMONITOR') {
            this.container = this.panel._centerBox;
        } else {
            this.container = this.panel._leftBox;
        }
        this.appMenu = this.panel.statusArea.appMenu;
        
        

        this._oldPanelHeight = this.panel.actor.get_height();

        // The overview uses the this.panel height as a margin by way of a "ghost" transparent Clone
        // This pushes everything down, which isn't desired when the this.panel is moved to the bottom
        // I'm adding a 2nd ghost this.panel and will resize the top or bottom ghost depending on the this.panel position
        this._myPanelGhost = new St.Bin({ 
            child: new Clutter.Clone({ source: this.panel.actor }),
            reactive: false,
            opacity: 0 
        });

        this._setPanelPosition();
        
        this._HeightNotifyListener = this.panelBox.connect("notify::height", Lang.bind(this, function(){
            this._setPanelPosition();
        }));

        // this is to catch changes to the window scale factor
        this._ScaleFactorListener = St.ThemeContext.get_for_stage(global.stage).connect("changed", Lang.bind(this, function () { 
            this._setPanelPosition();
        }));

        // The main panel's connection to the "allocate" signal is competing with this extension
        // trying to move the centerBox over to the right, creating a never-ending cycle.
        // Since we don't have the ID to disconnect that handler, wrap the allocate() function 
        // it calls instead. If the call didn't originate from this file, ignore it.
        this.panel._leftBox.oldLeftBoxAllocate = this.panel._leftBox.allocate;
        this.panel._leftBox.allocate = Lang.bind(this.panel._leftBox, function(box, flags, isFromDashToPanel) {
            if(isFromDashToPanel === true) 
                this.oldLeftBoxAllocate(box, flags);
        });

        this.panel._centerBox.oldCenterBoxAllocate = this.panel._centerBox.allocate;
        this.panel._centerBox.allocate = Lang.bind(this.panel._centerBox, function(box, flags, isFromDashToPanel) {
            if(isFromDashToPanel === true) 
                this.oldCenterBoxAllocate(box, flags);
        });

        this.panel._rightBox.oldRightBoxAllocate = this.panel._rightBox.allocate;
        this.panel._rightBox.allocate = Lang.bind(this.panel._rightBox, function(box, flags, isFromDashToPanel) {
            if(isFromDashToPanel === true) 
                this.oldRightBoxAllocate(box, flags);
        });

        this._panelConnectId = this.panel.actor.connect('allocate', Lang.bind(this, function(actor,box,flags){this._allocate(actor,box,flags);}));
        if(this.appMenu)
            this.panel._leftBox.remove_child(this.appMenu.container);
        this.taskbar = new Taskbar.taskbar(this._dtpSettings, this);
        Main.overview.dashIconSize = this.taskbar.iconSize;

        this.container.insert_child_at_index( this.taskbar.actor, 2 );
        
        this._oldLeftBoxStyle = this.panel._leftBox.get_style();
        this._oldCenterBoxStyle = this.panel._centerBox.get_style();
        this._oldRightBoxStyle = this.panel._rightBox.get_style();
        this._setActivitiesButtonVisible(this._dtpSettings.get_boolean('show-activities-button'));
        this._setAppmenuVisible(this._dtpSettings.get_boolean('show-appmenu'));
        this._setClockLocation(this._dtpSettings.get_string('location-clock'));
        this._displayShowDesktopButton(this._dtpSettings.get_boolean('show-showdesktop-button'));
        
        this.panel.actor.add_style_class_name('dashtopanelMainPanel');

        // Since Gnome 3.8 dragging an app without having opened the overview before cause the attemp to
        //animate a null target since some variables are not initialized when the viewSelector is created
        if(Main.overview.viewSelector._activePage == null)
            Main.overview.viewSelector._activePage = Main.overview.viewSelector._workspacesPage;

        if(this.taskbar._showAppsIcon)
            this.taskbar._showAppsIcon._dtpPanel = this;

        this.startIntellihideId = Mainloop.timeout_add(2000, () => {
            this.startIntellihideId = 0;
            this.intellihide = new Intellihide.Intellihide(this);
        });

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._signalsHandler.add(
            // Keep dragged icon consistent in size with this dash
            [
                this.taskbar,
                'icon-size-changed',
                Lang.bind(this, function() {
                    Main.overview.dashIconSize = this.taskbar.iconSize;
                })
            ],
            [
                // sync hover after a popupmenu is closed
                this.taskbar,
                'menu-closed', 
                Lang.bind(this, function(){this.container.sync_hover();})
            ],
            // This duplicate the similar signal which is in overview.js.
            // Being connected and thus executed later this effectively
            // overwrite any attempt to use the size of the default dash
            // which given the customization is usually much smaller.
            // I can't easily disconnect the original signal
            [
                Main.overview._controls.dash,
                'icon-size-changed',
                Lang.bind(this, function() {
                    Main.overview.dashIconSize = this.taskbar.iconSize;
                })
            ],
            [
                Main.overview,
                'hidden',
                () => this.panel._updateSolidStyle ? this.panel._updateSolidStyle() : null
            ],
            [
                Main.overview,
                [
                    'showing',
                    'hiding'
                ],
                () => {
                    let isFocusedMonitor = Main.overview._focusedMonitor == this.monitor;
                    let isOverview = !!Main.overview.visibleTarget;
                    let isShown = !isOverview || (isOverview && isFocusedMonitor);

                    this.panel.actor[isShown ? 'show' : 'hide']();
                    
                    if (isOverview && isFocusedMonitor) {
                        Main.overview._overview.add_actor(this._myPanelGhost);
                    } else if (this._myPanelGhost.get_parent()) {
                        Main.overview._overview.remove_actor(this._myPanelGhost);
                    }
                }
            ],
            [
                this.panel._rightBox,
                'actor-added',
                Lang.bind(this, function() {
                    this._setClockLocation(this._dtpSettings.get_string('location-clock'));
                })
            ],
            [
                this.panel._centerBox,
                'actor-added',
                () => this._setClockLocation(this._dtpSettings.get_string('location-clock'))
            ]
        );

        this._bindSettingsChanges();

        this.panelStyle.enable(this.panel);
        
        this.panel.handleDragOver = Lang.bind(this.panel, function(source, actor, x, y, time) {
            if (source == Main.xdndHandler) {
                
                // open overview so they can choose a window for focusing
                // and ultimately dropping dragged item onto
                if(Main.overview.shouldToggleByCornerOrButton())
                    Main.overview.show();
            }
            
            return DND.DragMotionResult.CONTINUE;
        });

        // Dynamic transparency is available on Gnome 3.26
        if (this.panel._updateSolidStyle) {
            this._injectionsHandler = new Utils.InjectionsHandler();
            this.panel._dtpPosition = this._dtpSettings.get_string('panel-position');
            this.panel._dtpRemoveSolidStyleId = 0;
            this._injectionsHandler.addWithLabel('transparency', [
                    this.panel,
                    '_updateSolidStyle',
                    Lang.bind(this.panel, this._dtpUpdateSolidStyle)
                ]);

            this.panel._updateSolidStyle();
        }
    },

    disable: function () {
        this.panelStyle.disable();

        this._signalsHandler.destroy();
        this.container.remove_child(this.taskbar.actor);
        this._setAppmenuVisible(false);
        if(this.appMenu)
            this.panel._leftBox.add_child(this.appMenu.container);
        this.taskbar.destroy();
        this.panel.actor.disconnect(this._panelConnectId);

        if (this.startIntellihideId) {
            Mainloop.source_remove(this.startIntellihideId);
            this.startIntellihideId = 0;
        } else {
            this.intellihide.destroy();
        }

        // reset stored icon size  to the default dash
        Main.overview.dashIconSize = Main.overview._controls.dash.iconSize;

        this.panel.actor.remove_style_class_name('dashtopanelMainPanel');

        // remove this.panel styling
        if(this._HeightNotifyListener !== null) {
            this.panelBox.disconnect(this._HeightNotifyListener);
        }
        if(this._ScaleFactorListener !== null) {
            St.ThemeContext.get_for_stage(global.stage).disconnect(this._ScaleFactorListener);
        }

        for (let i = 0; i < this._dtpSettingsSignalIds.length; ++i) {
            this._dtpSettings.disconnect(this._dtpSettingsSignalIds[i]);
        }

        this._removeTopLimit();

        if (this.panel._updateSolidStyle) {
            if (this.panel._dtpRemoveSolidStyleId) {
                Mainloop.source_remove(this.panel._dtpRemoveSolidStyleId);
            }

            this._injectionsHandler.removeWithLabel('transparency');
            this._injectionsHandler.destroy();

            delete this.panel._dtpPosition;
            delete this.panel._dtpRemoveSolidStyleId;
        }

        if (!this.isSecondary) {
            this.panel.actor.set_height(this._oldPanelHeight);
            this.panelBox.set_anchor_point(0, 0);
            
            Main.overview._panelGhost.set_height(this._oldPanelHeight);
            this._setActivitiesButtonVisible(true);
            this._setClockLocation("BUTTONSLEFT");
            this._displayShowDesktopButton(false);

            this.panel._leftBox.allocate = this.panel._leftBox.oldLeftBoxAllocate;
            delete this.panel._leftBox.oldLeftBoxAllocate;

            this.panel._centerBox.allocate = this.panel._centerBox.oldCenterBoxAllocate;
            delete this.panel._centerBox.oldCenterBoxAllocate;
            
            this.panel._rightBox.allocate = this.panel._rightBox.oldRightBoxAllocate;
            delete this.panel._rightBox.oldRightBoxAllocate;
        } else {
            Main.layoutManager.removeChrome(this.panelBox);
            this.panelBox.destroy();
        }

        this.appMenu = null;
        this.container = null;
        this.panel = null;
        this.taskbar = null;
        this._panelConnectId = null;
        this._signalsHandler = null;
        this._HeightNotifyListener = null;
    },

    _bindSettingsChanges: function() {
        this._dtpSettingsSignalIds = [
            //rebuild panel when taskar-position change
            this._dtpSettings.connect('changed::taskbar-position', Lang.bind(this, function() {
                this.disable();
                this.enable();
            })),

            this._dtpSettings.connect('changed::panel-position', Lang.bind(this, function() {
                this._setPanelPosition();
            })),

            this._dtpSettings.connect('changed::panel-size', Lang.bind(this, function() {
                this._setPanelPosition();
                this.taskbar.resetAppIcons();
            })),

            this._dtpSettings.connect('changed::appicon-margin', Lang.bind(this, function() {
                this.taskbar.resetAppIcons();
            })),

            this._dtpSettings.connect('changed::appicon-padding', Lang.bind(this, function() {
                this.taskbar.resetAppIcons();
            })),

            this._dtpSettings.connect('changed::show-activities-button', Lang.bind(this, function() {
                this._setActivitiesButtonVisible(this._dtpSettings.get_boolean('show-activities-button'));
            })),
            
            this._dtpSettings.connect('changed::show-appmenu', Lang.bind(this, function() {
                this._setAppmenuVisible(this._dtpSettings.get_boolean('show-appmenu'));
            })),

            this._dtpSettings.connect('changed::location-clock', Lang.bind(this, function() {
                this._setClockLocation(this._dtpSettings.get_string('location-clock'));
            })),

            this._dtpSettings.connect('changed::show-showdesktop-button', Lang.bind(this, function() {
                this._displayShowDesktopButton(this._dtpSettings.get_boolean('show-showdesktop-button'));
            })),

            this._dtpSettings.connect('changed::showdesktop-button-width', () => this._setShowDesktopButtonWidth())
        ];
    },

    _allocate: function(actor, box, flags) {
        let panelAllocWidth = box.x2 - box.x1;
        let panelAllocHeight = box.y2 - box.y1;

        let [leftMinWidth, leftNaturalWidth] = this.panel._leftBox.get_preferred_width(-1);
        let [centerMinWidth, centerNaturalWidth] = this.panel._centerBox.get_preferred_width(-1);
        let [rightMinWidth, rightNaturalWidth] = this.panel._rightBox.get_preferred_width(-1);
        
        let taskbarPosition = this._dtpSettings.get_string('taskbar-position');

        // The _rightBox is always allocated the same, regardless of taskbar position setting
        let rightAllocWidth = rightNaturalWidth;
        
        // Now figure out how large the _leftBox and _centerBox should be.
        // The box with the taskbar is always the one that is forced to be smaller as the other boxes grow
        let leftAllocWidth, centerStartPosition, centerEndPosition;
        if (taskbarPosition == 'CENTEREDMONITOR') {
            leftAllocWidth = leftNaturalWidth;

            centerStartPosition = Math.max(leftNaturalWidth, Math.floor((panelAllocWidth - centerNaturalWidth)/2));
            centerEndPosition = Math.min(panelAllocWidth-rightNaturalWidth, Math.ceil((panelAllocWidth+centerNaturalWidth))/2);
        } else if (taskbarPosition == 'CENTEREDCONTENT') {
            leftAllocWidth = leftNaturalWidth;

            centerStartPosition = Math.max(leftNaturalWidth, Math.floor((panelAllocWidth - centerNaturalWidth + leftNaturalWidth - rightNaturalWidth) / 2));
            centerEndPosition = Math.max(panelAllocWidth-rightNaturalWidth, Math.ceil((panelAllocWidth - centerNaturalWidth - leftNaturalWidth + rightNaturalWidth) / 2));
        } else if (taskbarPosition == 'LEFTPANEL_FIXEDCENTER') {
            leftAllocWidth = Math.floor((panelAllocWidth - centerNaturalWidth) / 2);
            centerStartPosition = leftAllocWidth;
            centerEndPosition = centerStartPosition + centerNaturalWidth;
        } else if (taskbarPosition == 'LEFTPANEL_FLOATCENTER') {
            let leftAllocWidthMax = panelAllocWidth - rightNaturalWidth - centerNaturalWidth;
            leftAllocWidth = Math.min(leftAllocWidthMax, leftNaturalWidth);

            let freeSpace = panelAllocWidth - leftAllocWidth - rightAllocWidth - centerNaturalWidth;

            centerStartPosition = leftAllocWidth + Math.floor(freeSpace / 2);
            centerEndPosition = centerStartPosition + centerNaturalWidth;
        } else { // LEFTPANEL
            leftAllocWidth = panelAllocWidth - rightNaturalWidth - centerNaturalWidth;
            centerStartPosition = leftAllocWidth;
            centerEndPosition = centerStartPosition + centerNaturalWidth;
        }

        let childBoxLeft = new Clutter.ActorBox();
        let childBoxCenter = new Clutter.ActorBox();
        let childBoxRight = new Clutter.ActorBox();
        childBoxLeft.y1 = childBoxCenter.y1 = childBoxRight.y1 = 0;
        childBoxLeft.y2 = childBoxCenter.y2 = childBoxRight.y2 = panelAllocHeight;

        // if it is a RTL language, the boxes are switched around, and we need to invert the coordinates
        if (this.panel.actor.get_text_direction() == Clutter.TextDirection.RTL) {
            childBoxLeft.x1 = panelAllocWidth - leftAllocWidth;
            childBoxLeft.x2 = panelAllocWidth;

            childBoxCenter.x1 = panelAllocWidth - centerEndPosition;
            childBoxCenter.x2 = panelAllocWidth - centerStartPosition;

            childBoxRight.x1 = 0;
            childBoxRight.x2 = rightAllocWidth;
        } else {
            childBoxLeft.x1 = 0;
            childBoxLeft.x2 = leftAllocWidth;

            childBoxCenter.x1 = centerStartPosition;
            childBoxCenter.x2 = centerEndPosition;

            childBoxRight.x1 = panelAllocWidth - rightAllocWidth;
            childBoxRight.x2 = panelAllocWidth;            
        }
       
        let childBoxLeftCorner = new Clutter.ActorBox();
        let [cornerMinWidth, cornerWidth] = this.panel._leftCorner.actor.get_preferred_width(-1);
        let [cornerMinHeight, cornerHeight] = this.panel._leftCorner.actor.get_preferred_width(-1);
        childBoxLeftCorner.x1 = 0;
        childBoxLeftCorner.x2 = cornerWidth;
        childBoxLeftCorner.y1 = panelAllocHeight;
        childBoxLeftCorner.y2 = panelAllocHeight + cornerHeight;

        let childBoxRightCorner = new Clutter.ActorBox();
        [cornerMinWidth, cornerWidth] = this.panel._rightCorner.actor.get_preferred_width(-1);
        [cornerMinHeight, cornerHeight] = this.panel._rightCorner.actor.get_preferred_width(-1);
        childBoxRightCorner.x1 = panelAllocWidth - cornerWidth;
        childBoxRightCorner.x2 = panelAllocWidth;
        childBoxRightCorner.y1 = panelAllocHeight;
        childBoxRightCorner.y2 = panelAllocHeight + cornerHeight;

        this.panel._leftBox.allocate(childBoxLeft, flags, true);
        this.panel._centerBox.allocate(childBoxCenter, flags, true);
        this.panel._rightBox.allocate(childBoxRight, flags, true);
        this.panel._leftCorner.actor.allocate(childBoxLeftCorner, flags);
        this.panel._rightCorner.actor.allocate(childBoxRightCorner, flags);
    },

    _setPanelPosition: function() {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let size = this._dtpSettings.get_int('panel-size');
        
        if(scaleFactor)
            size = size*scaleFactor;

        this.panel.actor.set_height(size);

        let position = this._dtpSettings.get_string('panel-position');
        let isTop = position == "TOP";

        Main.overview._panelGhost.set_height(isTop ? size : 0);
        this._myPanelGhost.set_height(isTop ? 0 : size);

        if(isTop) {
            this.panelBox.set_anchor_point(0, 0);

            this._removeTopLimit();
            
            // styles for theming
            if(this.panel.actor.has_style_class_name('dashtopanelBottom'))
                this.panel.actor.remove_style_class_name('dashtopanelBottom');

            if(!this.panel.actor.has_style_class_name('dashtopanelTop'))
                this.panel.actor.add_style_class_name('dashtopanelTop');
        } else {
            this.panelBox.set_anchor_point(0,(-1)*(this.monitor.height-this.panelBox.height));

            if (!this._topLimit) {
                this._topLimit = new St.BoxLayout({ name: 'topLimit', vertical: true });
                Main.layoutManager.addChrome(this._topLimit, { affectsStruts: true, trackFullscreen: true });
            }

            this._topLimit.set_position(this.monitor.x, this.monitor.y);
            this._topLimit.set_size(this.monitor.width, -1);

            // styles for theming
            if(this.panel.actor.has_style_class_name('dashtopanelTop'))
                this.panel.actor.remove_style_class_name('dashtopanelTop');

            if(!this.panel.actor.has_style_class_name('dashtopanelBottom'))
                this.panel.actor.add_style_class_name('dashtopanelBottom');
        }

        Main.layoutManager._updateHotCorners();
        Main.layoutManager._updatePanelBarrier();
    },

    _removeTopLimit: function() {
        if (this._topLimit) {
            Main.layoutManager.removeChrome(this._topLimit);
            this._topLimit = null;
        }
    },

    _setActivitiesButtonVisible: function(isVisible) {
        if(this.panel.statusArea.activities)
            isVisible ? this.panel.statusArea.activities.actor.show() :
                this.panel.statusArea.activities.actor.hide();
    },
    
    _setAppmenuVisible: function(isVisible) {
        let parent;
        if(this.appMenu)
            parent = this.appMenu.container.get_parent();

        if (parent) {
            parent.remove_child(this.appMenu.container);
        }

        if (isVisible && this.appMenu) {
            let taskbarPosition = this._dtpSettings.get_string('taskbar-position');
            if (taskbarPosition == 'CENTEREDCONTENT' || taskbarPosition == 'CENTEREDMONITOR') {
                this.panel._leftBox.insert_child_above(this.appMenu.container, null);
            } else {
                this.panel._centerBox.insert_child_at_index(this.appMenu.container, 0);
            }            
        }
    },

    _setClockLocation: function(loc) {
        if(!this.panel.statusArea.dateMenu)
            return;

        let dateMenuContainer = this.panel.statusArea.dateMenu.container;
        let parent = dateMenuContainer.get_parent();
        let destination;
        let refSibling = null;

        if (!parent) {
            return;
        }

        if (loc.indexOf('BUTTONS') == 0) {
            destination = this.panel._centerBox;
        } else if (loc.indexOf('STATUS') == 0) {
            refSibling = this.panel.statusArea.aggregateMenu.container;
            destination = this.panel._rightBox;
        } else { //TASKBAR
            refSibling = this.taskbar.actor;
            destination = refSibling.get_parent();
        }

        if (parent != destination) {
            parent.remove_actor(dateMenuContainer);
            destination.add_actor(dateMenuContainer);
        }

        destination['set_child_' + (loc.indexOf('RIGHT') > 0 ? 'above' : 'below') + '_sibling'](dateMenuContainer, refSibling);
    },

    _displayShowDesktopButton: function (isVisible) {
        if(isVisible) {
            if(this._showDesktopButton)
                return;

            this._showDesktopButton = new St.Bin({ style_class: 'showdesktop-button',
                            reactive: true,
                            can_focus: true,
                            x_fill: true,
                            y_fill: true,
                            track_hover: true });

            this._setShowDesktopButtonWidth();

            this._showDesktopButton.connect('button-press-event', Lang.bind(this, this._onShowDesktopButtonPress));

            this._showDesktopButton.connect('enter-event', Lang.bind(this, function(){
                this._showDesktopButton.add_style_class_name('showdesktop-button-hovered');
            }));
            
            this._showDesktopButton.connect('leave-event', Lang.bind(this, function(){
                this._showDesktopButton.remove_style_class_name('showdesktop-button-hovered');
            }));

            this.panel._rightBox.insert_child_at_index(this._showDesktopButton, this.panel._rightBox.get_children().length);
        } else {
            if(!this._showDesktopButton)
                return;

            this.panel._rightBox.remove_child(this._showDesktopButton);
            this._showDesktopButton.destroy();
            this._showDesktopButton = null;
        }
    },

    _setShowDesktopButtonWidth: function() {
        if (this._showDesktopButton) {
            this._showDesktopButton.set_style('width: ' + this._dtpSettings.get_int('showdesktop-button-width') + 'px;');
        }
    },

    _onShowDesktopButtonPress: function() {
        if(this._focusAppChangeId){
            tracker.disconnect(this._focusAppChangeId);
            this._focusAppChangeId = null;
        }

        if(this._restoreWindowList && this._restoreWindowList.length) {
            let current_workspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
            let windows = current_workspace.list_windows();
            this._restoreWindowList.forEach(function(w) {
                if(windows.indexOf(w) > -1)
                    Main.activateWindow(w);
            });
            this._restoreWindowList = null;

            Main.overview.hide();
        } else {
            let current_workspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
            let windows = current_workspace.list_windows().filter(function (w) {
                return w.showing_on_its_workspace() && !w.skip_taskbar;
            });
            windows = global.display.sort_windows_by_stacking(windows);

            windows.forEach(function(w) {
                w.minimize();
            });
            
            this._restoreWindowList = windows;

            Mainloop.timeout_add(0, Lang.bind(this, function () {
                this._focusAppChangeId = tracker.connect('notify::focus-app', Lang.bind(this, function () {
                    this._restoreWindowList = null;
                }));
            }));

            Main.overview.hide();
        }
    },

    _dtpUpdateSolidStyle: function() {
        let removeSolidStyle = function(solid) {
            this._dtpRemoveSolidStyleId = Mainloop.timeout_add(0, () => {
                this._dtpRemoveSolidStyleId = 0;
                this._removeStyleClassName('solid');
            });
        };

        if (this.actor.has_style_pseudo_class('overview') || !Main.sessionMode.hasWindows) {
            removeSolidStyle.call(this);
            return;
        }

        if (!Main.layoutManager.primaryMonitor)
            return;

        /* Get all the windows in the active workspace that are in the primary monitor and visible */
        let activeWorkspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
        let windows = activeWorkspace.list_windows().filter(function(metaWindow) {
            return metaWindow.is_on_primary_monitor() &&
                   metaWindow.showing_on_its_workspace() &&
                   metaWindow.get_window_type() != Meta.WindowType.DESKTOP;
        });

        /* Check if at least one window is near enough to the panel */
        let [, panelTop] = this.actor.get_transformed_position();
        let panelBottom = panelTop + this.actor.get_height();
        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let isNearEnough = windows.some(Lang.bind(this, function(metaWindow) {
            if (this.hasOwnProperty('_dtpPosition') && this._dtpPosition === 'TOP') {
                let verticalPosition = metaWindow.get_frame_rect().y;
                return verticalPosition < panelBottom + 5 * scale;
            } else {
                let verticalPosition = metaWindow.get_frame_rect().y + metaWindow.get_frame_rect().height;
                return verticalPosition > panelTop - 5 * scale;
            }
        }));

        if (isNearEnough) {
            this._addStyleClassName('solid');
        } else {
            removeSolidStyle.call(this);
        }
    }
});


var dtpSecondaryPanelBoxWrapper = new Lang.Class({
    Name: 'DashToPanel.SecondaryPanelBox',

    _init: function (monitor) {
		this._rightPanelBarrier = null;
	
        this.panelBox = new St.BoxLayout({ name: 'panelBox', vertical: true });
        
        Main.layoutManager.addChrome(this.panelBox, { affectsStruts: true, trackFullscreen: true });
        this.panelBox.set_position(monitor.x, monitor.y);
        this.panelBox.set_size(monitor.width, -1);
        Main.uiGroup.set_child_below_sibling(this.panelBox, Main.layoutManager.panelBox);
        
        this._panelBoxChangedId = this.panelBox.connect('allocation-changed', Lang.bind(this, this._panelBoxChanged));
        
        this.panel = new dtpSecondaryPanel();
        this.panelBox.add(this.panel.actor);
	},
	
	destroy: function () {
		if (this._rightPanelBarrier) {
	        this._rightPanelBarrier.destroy();
	        this._rightPanelBarrier = null;
	    }
	
		this.panelBox.disconnect(this._panelBoxChangedId);
		this.panelBox.destroy();
	},
	
	updatePanel: function(monitor) {
	    this.panelBox.set_position(monitor.x, monitor.y);
	    this.panelBox.set_size(monitor.width, -1);
	},

	_panelBoxChanged: function(self, box, flags) {
	    if (this._rightPanelBarrier) {
	        this._rightPanelBarrier.destroy();
	        this._rightPanelBarrier = null;
	    }
	    
	    if (this.panelBox.height) {
	    	this._rightPanelBarrier = new Meta.Barrier({ display: global.display,
	    									x1: box.get_x() + box.get_width(), y1: box.get_y(),
								            x2: box.get_x() + box.get_width(), y2: box.get_y() + this.panelBox.height,
								            directions: Meta.BarrierDirection.NEGATIVE_X });
	    }
	},
});

var dtpSecondaryPanel = new Lang.Class({
    Name: 'DashToPanel.SecondaryPanel',
    Extends: Panel.Panel,

    _init : function(settings, monitor) {
        this._dtpSettings = settings;
   	
        this.actor = new Shell.GenericContainer({ name: 'panel', reactive: true });
        this.actor._delegate = this;

        this._sessionStyle = null;

        this.statusArea = { aggregateMenu: { container: null } };

        this.menuManager = new PopupMenu.PopupMenuManager(this);

        this._leftBox = new St.BoxLayout({ name: 'panelLeft' });
        this.actor.add_actor(this._leftBox);
        this._centerBox = new St.BoxLayout({ name: 'panelCenter' });
        this.actor.add_actor(this._centerBox);
        this._rightBox = new St.BoxLayout({ name: 'panelRight' });
        this.actor.add_actor(this._rightBox);

        this._leftCorner = new Panel.PanelCorner(St.Side.LEFT);
        this.actor.add_actor(this._leftCorner.actor);

        this._rightCorner = new Panel.PanelCorner(St.Side.RIGHT);
        this.actor.add_actor(this._rightCorner.actor);

        this._setDateMenu();
        this.showClockOnAllMonitorsId = this._dtpSettings.connect('changed::show-clock-all-monitors', () => this._setDateMenu());

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
       
        Main.ctrlAltTabManager.addGroup(this.actor, _("Top Bar")+" "+ monitor.index, 'focus-top-bar-symbolic',
                                        { sortGroup: CtrlAltTab.SortGroup.TOP });

    },

    _setDateMenu: function() {
        if (!this._dtpSettings.get_boolean('show-clock-all-monitors')) {
            this._removeDateMenu();
        } else if (!this.statusArea.dateMenu) {
            this.statusArea.dateMenu = new DateMenu.DateMenuButton();
            this.menuManager.addMenu(this.statusArea.dateMenu.menu);

            //adding the clock to the centerbox will correctly position it according to dtp settings (event in dtpPanelWrapper)
            this._centerBox.add_actor(this.statusArea.dateMenu.container);
        }
    },
    
    _removeDateMenu: function() {
        if (this.statusArea.dateMenu) {
            let parent = this.statusArea.dateMenu.container.get_parent();

            if (parent) {
                parent.remove_actor(this.statusArea.dateMenu.container);
            }

            //this.statusArea.dateMenu.destroy(); //buggy for now, creates the same error as when destroying the default gnome-shell clock
            this.menuManager.removeMenu(this.statusArea.dateMenu.menu);
            this.statusArea.dateMenu = null;
        }
    },

    _onDestroy: function(actor) {
	    Main.ctrlAltTabManager.removeGroup(this.actor);
        
        this._dtpSettings.disconnect(this.showClockOnAllMonitorsId);
        this._removeDateMenu();
        
        this.actor._delegate = null;
    },
  
});